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

// The MCP build's Docusaurus config: the site's own config plus the
// plugin that writes build/mcp/docs.json. It wraps docusaurus.config.js
// instead of editing it, so the MCP artifact build can be laid on top
// of ANY upstream checkout without a merge (see .github/mcp/build.sh).
// Build with: docusaurus build --config docusaurus.config.mcp.js

import config from './docusaurus.config.js';

const MCP_PLUGIN = 'docusaurus-plugin-mcp-server';

const isMcpPlugin = (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === MCP_PLUGIN;

export default {
    ...config,
    plugins: [
        // Drop any registration the wrapped config already carries, so
        // the options below are the single source of truth.
        ...(config.plugins ?? []).filter((plugin) => !isMcpPlugin(plugin)),
        [
            MCP_PLUGIN,
            {
                server: {
                    name: 'my-docs',
                    version: '1.0.0',
                },
                flexsearch: {
                    tokenize: 'strict',
                    resolution: 3,
                    context: false,
                },
            },
        ],
    ],
};
