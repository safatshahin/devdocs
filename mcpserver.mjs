/**
 * Copyright (c) Moodle Pty Ltd.
 *
 * Moodle is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Moodle is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Moodle.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * MCP server for the built Moodle developer docs.
 *
 * Serves docs_search / docs_fetch over streamable HTTP (stateless JSON
 * mode) from build/mcp/docs.json, which the docusaurus-plugin-mcp-server
 * postBuild hook generates (that plugin is now used for artifact
 * generation only - its runtime FlexSearch server is replaced by this
 * file, which fixes three problems the packaged server had):
 *
 * 1. Relevance: BM25 ranking with OR semantics and prefix matching,
 *    instead of strict whole-token AND matching (where one stray query
 *    word returned nothing, and "auth" could never match
 *    "authentication").
 * 2. Version noise: each docs page exists once per Moodle version;
 *    results are collapsed to one hit per page (preferring the
 *    requested or newest version) instead of burning the result list
 *    on near-identical version copies.
 * 3. Token cost: docs_fetch can return a single section (via URL
 *    #anchor or the section argument) using the heading offsets the
 *    build already records, and large pages return a table of
 *    contents plus guidance instead of tens of thousands of tokens.
 *
 * Run from the repo root after `yarn build`:  node mcpserver.mjs
 * Env: PORT (default 3001), DOCS_DIR (default ./build/mcp).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.PORT || 3001);
const DOCS_DIR = process.env.DOCS_DIR || './build/mcp';
const MAX_BODY_SIZE = 4 * 1024 * 1024;
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;
const SNIPPET_LENGTH = 300;
// Pages larger than this return a TOC instead of the full body unless
// full=true - a docs page beyond this is several thousand tokens, and
// the caller almost always wants one section of it.
const LARGE_PAGE_CHARS = 12000;

// ---------------------------------------------------------------------------
// Corpus loading and normalization
// ---------------------------------------------------------------------------

/** Clean a heading generated from rendered Docusaurus HTML:
 *  "Classname[​](#classname \"Direct link...\")" ->
 *  { text: "Classname", anchor: "classname" }  */
function cleanHeading(rawText) {
    const link = rawText.match(/\[​?\]\(#([^\s)"]+)[^)]*\)/);
    const text = rawText.replace(/\[​?\]\([^)]*\)/g, '').trim();
    const anchor = link ? link[1]
        : text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return { text, anchor };
}

/** Route -> { area, version, canonical } - the canonical id groups the
 *  per-version copies of one docs page ("/docs/5.2/apis/..." and
 *  "/docs/4.5/apis/..." share "/docs/apis/..."). */
function routeVersion(route) {
    const match = route.match(/^\/docs\/(\d+\.\d+)(\/.*|$)/);
    if (match) {
        return { area: 'docs', version: match[1], canonical: `/docs${match[2] || ''}` };
    }
    return { area: route.startsWith('/general') ? 'general' : 'other',
             version: null, canonical: route };
}

function loadCorpus() {
    const docsPath = path.resolve(DOCS_DIR, 'docs.json');
    const raw = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
    const pages = [];
    const byUrl = new Map();       // normalized url -> page
    const byCanonical = new Map(); // canonical route -> [pages]

    for (const [url, doc] of Object.entries(raw)) {
        const { area, version, canonical } = routeVersion(doc.route);
        const headings = (doc.headings || []).map((h) => ({
            ...cleanHeading(h.text || ''),
            level: h.level,
            startOffset: h.startOffset,
            endOffset: h.endOffset,
        }));
        // Meta descriptions sometimes carry leaked MDX comment markup
        // ("{/ ... /}") instead of prose - drop those.
        const description = /^\{\/.*\/\}$/.test((doc.description || '').trim())
            ? '' : (doc.description || '');
        const page = {
            url, route: doc.route, area, version, canonical,
            title: (doc.title || '').replace(/ \| Moodle Developer Resources.*$/, ''),
            description,
            markdown: doc.markdown || '',
            headings,
        };
        pages.push(page);
        byUrl.set(normalizeUrl(url), page);
        if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
        byCanonical.get(canonical).push(page);
    }

    const versions = [...new Set(pages.map((p) => p.version).filter(Boolean))]
        .sort((a, b) => parseFloat(b) - parseFloat(a));
    return { pages, byUrl, byCanonical, versions, currentVersion: versions[0] };
}

function normalizeUrl(url) {
    return url.replace(/^http:/, 'https:').replace(/#.*$/, '')
        .replace(/\/+$/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// BM25 index (per page, field-weighted, OR semantics, prefix matching)
// ---------------------------------------------------------------------------

const FIELD_WEIGHTS = { title: 4, headings: 2.5, description: 2, content: 1 };
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9_]+/g) || [])
        .filter((t) => t.length >= 2)
        .map(stem);
}

/** Conservative suffix stripping - only unambiguous English suffixes on
 *  reasonably long words, so identifiers like "settings" and "config"
 *  still meet their prose forms without mangling short terms. */
function stem(token) {
    if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
    if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
    if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
        return token.slice(0, -1);
    }
    return token;
}

function buildIndex(corpus) {
    // postings: token -> Map(pageIdx -> {field: termFrequency})
    const postings = new Map();
    const fieldLengths = [];
    for (let i = 0; i < corpus.pages.length; i++) {
        const page = corpus.pages[i];
        const fields = {
            title: tokenize(page.title),
            headings: tokenize(page.headings.map((h) => h.text).join(' ')),
            description: tokenize(page.description),
            content: tokenize(page.markdown),
        };
        const lengths = {};
        for (const [field, tokens] of Object.entries(fields)) {
            lengths[field] = tokens.length;
            for (const token of tokens) {
                let entry = postings.get(token);
                if (!entry) postings.set(token, (entry = new Map()));
                let counts = entry.get(i);
                if (!counts) entry.set(i, (counts = {}));
                counts[field] = (counts[field] || 0) + 1;
            }
        }
        fieldLengths.push(lengths);
    }
    const avgFieldLength = {};
    for (const field of Object.keys(FIELD_WEIGHTS)) {
        avgFieldLength[field] = fieldLengths.reduce(
            (sum, l) => sum + (l[field] || 0), 0) / (fieldLengths.length || 1);
    }
    const sortedTokens = [...postings.keys()].sort();
    return { postings, fieldLengths, avgFieldLength, sortedTokens,
             docCount: corpus.pages.length };
}

/** Tokens matching a query term exactly or by prefix (>=3 chars). */
function expandTerm(index, term) {
    const matches = new Set();
    if (index.postings.has(term)) matches.add(term);
    if (term.length >= 3) {
        const tokens = index.sortedTokens;
        let lo = 0, hi = tokens.length;
        while (lo < hi) { // first token >= term
            const mid = (lo + hi) >> 1;
            if (tokens[mid] < term) lo = mid + 1; else hi = mid;
        }
        for (let i = lo; i < tokens.length && tokens[i].startsWith(term)
                && matches.size < 25; i++) {
            matches.add(tokens[i]);
        }
    }
    return matches;
}

function search(corpus, index, query, limit, version) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];

    const scores = new Map(); // pageIdx -> {score, matchedTerms:Set}
    for (const term of terms) {
        // Merge postings of the exact term and its prefix expansions,
        // scoring each page once per query term (best variant wins) so
        // prefix noise can't out-score an exact match.
        const perPage = new Map(); // pageIdx -> best tf per field
        for (const token of expandTerm(index, term)) {
            const exact = token === term;
            for (const [pageIdx, counts] of index.postings.get(token)) {
                const prev = perPage.get(pageIdx);
                // Exact matches count fully; prefix variants at half.
                const factor = exact ? 1 : 0.5;
                const weighted = {};
                for (const [field, tf] of Object.entries(counts)) {
                    weighted[field] = tf * factor;
                }
                if (!prev || (prev.factor < factor)) {
                    perPage.set(pageIdx, { counts: weighted, factor });
                }
            }
        }
        const df = perPage.size;
        if (!df) continue;
        const idf = Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));
        for (const [pageIdx, { counts }] of perPage) {
            let termScore = 0;
            for (const [field, tf] of Object.entries(counts)) {
                const len = index.fieldLengths[pageIdx][field] || 0;
                const avg = index.avgFieldLength[field] || 1;
                const norm = tf * (BM25_K1 + 1)
                    / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (len / avg)));
                termScore += FIELD_WEIGHTS[field] * idf * norm;
            }
            let entry = scores.get(pageIdx);
            if (!entry) scores.set(pageIdx, (entry = { score: 0, matched: new Set() }));
            entry.score += termScore;
            entry.matched.add(term);
        }
    }

    // Small boost for matching more distinct query terms (OR semantics,
    // but coverage matters), then collapse version duplicates.
    const ranked = [...scores.entries()]
        .map(([pageIdx, { score, matched }]) => ({
            page: corpus.pages[pageIdx],
            score: score * (1 + 0.15 * (matched.size - 1)),
            matched,
        }))
        .sort((a, b) => b.score - a.score);

    if (version === 'all') {
        return ranked.slice(0, limit).map((hit) => ({ ...hit, otherVersions: [] }));
    }

    const wanted = version || null;
    const otherVersionsOf = (page) => corpus.byCanonical.get(page.canonical)
        .map((p) => p.version).filter((v) => v && v !== page.version)
        .sort((a, b) => parseFloat(b) - parseFloat(a));
    const seen = new Map(); // canonical -> result
    const results = [];
    for (const hit of ranked) {
        const key = hit.page.canonical;
        const existing = seen.get(key);
        if (!existing) {
            if (wanted && hit.page.version && hit.page.version !== wanted) {
                // Prefer the requested version's copy if it exists.
                const sibling = corpus.byCanonical.get(key)
                    .find((p) => p.version === wanted);
                if (sibling) hit.page = sibling;
            }
            hit.otherVersions = otherVersionsOf(hit.page);
            seen.set(key, hit);
            results.push(hit);
            if (results.length >= limit) break;
        } else if (!wanted && hit.page.version
                && existing.page.version
                && parseFloat(hit.page.version) > parseFloat(existing.page.version)
                && hit.score >= existing.score * 0.8) {
            existing.page = hit.page; // prefer newest version on ~equal score
            existing.otherVersions = otherVersionsOf(hit.page);
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Snippets and sections
// ---------------------------------------------------------------------------

function stripMarkdown(text) {
    return text
        .replace(/```[\s\S]*?```/g, ' [code] ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#*_`>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The section of a page whose text matches the most query terms -
 *  snippets come from where the page actually matched, not from its
 *  first paragraph. */
function bestSection(page, terms) {
    let best = null;
    for (const h of page.headings) {
        if (h.startOffset == null || h.endOffset == null) continue;
        const text = page.markdown.slice(h.startOffset, h.endOffset).toLowerCase();
        let count = 0;
        for (const term of terms) if (text.includes(term)) count++;
        if (count > 0 && (!best || count > best.count)) best = { heading: h, count };
    }
    return best?.heading || null;
}

function makeSnippet(page, terms) {
    const section = bestSection(page, terms);
    const source = section
        ? page.markdown.slice(section.startOffset, section.endOffset)
        : page.markdown;
    const plain = stripMarkdown(source);
    const lower = plain.toLowerCase();
    let hit = -1;
    for (const term of terms) {
        const at = lower.indexOf(term);
        if (at !== -1 && (hit === -1 || at < hit)) hit = at;
    }
    const start = Math.max(0, (hit === -1 ? 0 : hit) - 60);
    const snippet = plain.slice(start, start + SNIPPET_LENGTH).trim();
    return {
        snippet: (start > 0 ? '...' : '') + snippet
            + (start + SNIPPET_LENGTH < plain.length ? '...' : ''),
        sectionAnchor: section?.anchor || null,
        sectionTitle: section?.text || null,
    };
}

function findSection(page, wanted) {
    const target = wanted.replace(/^#/, '').toLowerCase();
    return page.headings.find((h) => h.anchor.toLowerCase() === target)
        || page.headings.find(
            (h) => h.text.toLowerCase() === target.replace(/-/g, ' '))
        || page.headings.find(
            (h) => h.text.toLowerCase().includes(target.replace(/-/g, ' ')));
}

function tocLines(page) {
    return page.headings.filter((h) => h.level <= 3).map(
        (h) => `${'  '.repeat(Math.max(0, h.level - 2))}- ${h.text} (#${h.anchor})`);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function runSearch(corpus, index, args) {
    const query = String(args.query || '').trim();
    const limit = Math.min(Math.max(1, args.limit || SEARCH_DEFAULT_LIMIT),
                           SEARCH_MAX_LIMIT);
    const version = args.version ? String(args.version) : null;
    const results = search(corpus, index, query, limit, version);
    if (!results.length) {
        return `No results for "${query}". Try fewer or different keywords - `
            + 'matching is OR-based, so single precise terms work well.';
    }
    const terms = [...new Set(tokenize(query))];
    const lines = [`Found ${results.length} result(s) for "${query}"`
        + (version ? ` (version ${version})` : '') + ':', ''];
    results.forEach((hit, i) => {
        const { page } = hit;
        const { snippet, sectionAnchor, sectionTitle } = makeSnippet(page, terms);
        lines.push(`${i + 1}. **${page.title}**`);
        lines.push(`   URL: ${page.url}`);
        if (page.version) {
            lines.push(`   Version: ${page.version}`
                + (hit.otherVersions.length
                    ? ` (also available: ${hit.otherVersions.join(', ')})` : ''));
        }
        if (sectionTitle) {
            lines.push(`   Best section: ${sectionTitle} (#${sectionAnchor})`);
        }
        lines.push(`   ${snippet}`);
        lines.push('');
    });
    lines.push('Fetch one section (cheapest) with docs_fetch and the URL plus '
        + '"#<anchor>" (anchors shown above), or the whole page with the bare '
        + 'URL. Other versions of a page share its path with /docs/<version>/.');
    return lines.join('\n');
}

function runFetch(corpus, args) {
    const rawUrl = String(args.url || '');
    const anchorInUrl = (rawUrl.match(/#(.+)$/) || [])[1] || null;
    const wantedSection = args.section ? String(args.section) : anchorInUrl;
    const page = corpus.byUrl.get(normalizeUrl(rawUrl));
    if (!page) {
        return 'Page not found. Use a URL exactly as returned by docs_search '
            + '(https://moodledev.io/...).';
    }
    const header = [`# ${page.title}`,
                    page.description ? `> ${page.description}` : '',
                    `URL: ${page.url}`].filter(Boolean);

    if (wantedSection) {
        const section = findSection(page, wantedSection);
        if (section && section.startOffset != null) {
            const body = page.markdown.slice(section.startOffset, section.endOffset);
            return [...header, '',
                    `## Section: ${section.text}`, '', body.trim(), '',
                    '---', 'Other sections on this page:',
                    ...tocLines(page)].join('\n');
        }
        return [...header, '',
                `Section "${wantedSection}" not found. Sections on this page:`,
                ...tocLines(page)].join('\n');
    }

    if (page.markdown.length > LARGE_PAGE_CHARS && !args.full) {
        return [...header, '',
                `This page is large (${page.markdown.length} chars). Fetch the `
                + 'section you need by adding "#<anchor>" to the URL (or pass '
                + 'section), or pass full=true for the whole page.', '',
                'Contents:', ...tocLines(page)].join('\n');
    }
    return [...header, '', page.markdown].join('\n');
}

// ---------------------------------------------------------------------------
// MCP wiring (streamable HTTP, stateless JSON mode)
// ---------------------------------------------------------------------------

const TOOLS = (corpus) => [
    {
        name: 'docs_search',
        description:
            'Search the Moodle developer documentation (moodledev.io). '
            + 'Keyword search with relevance ranking; results are collapsed '
            + 'to one hit per page across Moodle versions '
            + `(${corpus.versions.join(', ')}; newest preferred unless a `
            + 'version is given). /general/ pages are unversioned. Each '
            + 'result shows the best-matching section anchor - fetch just '
            + 'that section to keep context small.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search terms (OR-matched, ranked).',
                },
                limit: {
                    type: 'number',
                    description: `Max results (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).`,
                },
                version: {
                    type: 'string',
                    description: 'Moodle docs version like "5.2"; "all" disables version collapsing.',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'docs_fetch',
        description:
            'Fetch a documentation page, or one section of it. Pass the URL '
            + 'from docs_search; append "#<anchor>" (or pass section) to get '
            + 'a single section - strongly preferred, whole pages can be '
            + 'very large. Large pages return a table of contents unless '
            + 'full=true.',
        inputSchema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'Page URL from docs_search, optionally with #anchor.',
                },
                section: {
                    type: 'string',
                    description: 'Section anchor or heading text.',
                },
                full: {
                    type: 'boolean',
                    description: 'Force the entire page even when large.',
                },
            },
            required: ['url'],
        },
    },
];

function createMcpServer(corpus, index) {
    const server = new Server(
        { name: 'moodle-docs', version: '2.0.0' },
        { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS(corpus),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;
        try {
            if (name === 'docs_search') {
                return { content: [{ type: 'text', text: runSearch(corpus, index, args) }] };
            }
            if (name === 'docs_fetch') {
                return { content: [{ type: 'text', text: runFetch(corpus, args) }] };
            }
            return { content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                     isError: true };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: ${error.message}` }],
                     isError: true };
        }
    });
    return server;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                reject(new Error('body too large'));
                req.destroy();
            } else {
                chunks.push(chunk);
            }
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

console.log(`Loading docs corpus from ${DOCS_DIR} ...`);
const corpus = loadCorpus();
const index = buildIndex(corpus);
console.log(`Indexed ${corpus.pages.length} pages `
    + `(${corpus.byCanonical.size} unique across versions `
    + `${corpus.versions.join(', ')}).`);

const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
                  'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version');
    if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
    }
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            name: 'moodle-docs', version: '2.0.0',
            docCount: corpus.pages.length,
            uniquePages: corpus.byCanonical.size,
            versions: corpus.versions,
        }));
        return;
    }
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
    }
    try {
        const body = await readBody(req);
        // Stateless: a fresh server+transport pair per request, JSON
        // responses (no SSE stream to manage) - the same pattern the
        // previous packaged server used, so existing clients keep
        // working unchanged.
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        const mcp = createMcpServer(corpus, index);
        res.on('close', () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (error) {
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }
});

httpServer.listen(PORT, () => {
    console.log(`MCP server running at http://localhost:${PORT}/mcp`);
});
