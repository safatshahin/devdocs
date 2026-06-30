#!/usr/bin/env bash
# Builds the MCP release assets from an UPSTREAM checkout plus this
# branch's MCP files, without merging the two in git.
#
#   .github/mcp/build.sh <upstream-checkout> <output-dir>
#
# Why not build this branch directly: it is upstream plus one commit, and
# keeping that commit rebased every night failed in two ways - text
# conflicts in package.json whenever upstream bumped a neighbouring
# dependency, and GitHub refusing bot pushes of upstream commits that
# touch workflow files. Laying the MCP files over a fresh upstream
# checkout and adding the dependencies by command has neither problem:
# nothing is merged and nothing is pushed.
#
# The same script runs locally (needs Node per .nvmrc and corepack yarn).
set -euo pipefail

OVERLAY="$(cd "$(dirname "$0")/../.." && pwd)"
UPSTREAM="$(cd "$1" && pwd)"
mkdir -p "$2"
OUT="$(cd "$2" && pwd)"

# The packages the MCP build adds to upstream's own, pinned EXACTLY.
# Upstream's lockfile pins everything upstream uses, but these arrive
# without one, and a floating range broke the build once already: a
# fresh resolve picked zod 4.6.5, whose packaging Docusaurus's module
# loader (jiti) cannot import (`import { z } from 'zod'` came back
# undefined). These three versions are verified together; raising one
# is a deliberate edit followed by a local run of this script.
MCP_SDK='@modelcontextprotocol/sdk@1.29.0'
MCP_PLUGIN='docusaurus-plugin-mcp-server@1.0.0'
ZOD_VERSION='4.4.3'

# 1. The MCP files: additions only, nothing upstream owns is replaced.
cp "$OVERLAY/mcpserver.mjs" "$OVERLAY/docusaurus.config.mcp.js" "$UPSTREAM/"

cd "$UPSTREAM"

# 2. Dependencies by command, never by text merge. `yarn add` installs
#    everything and rewrites the (throwaway) manifest and lockfile.
#    zod is a transitive dependency of both, so it is pinned through a
#    resolution rather than as a dependency of its own.
export YARN_ENABLE_IMMUTABLE_INSTALLS=false
npm pkg set "resolutions.zod=$ZOD_VERSION"
yarn add --dev --exact "$MCP_SDK" "$MCP_PLUGIN"

# 3. Build the site with the wrapper config; the plugin writes
#    build/mcp/docs.json and manifest.json.
yarn docusaurus build --config docusaurus.config.mcp.js
test -s build/mcp/docs.json

# 4. Bundle the server with its only dependency, so consumers run
#    `node mcpserver.mjs` with no node_modules.
npx --yes esbuild@0.24.2 mcpserver.mjs \
    --bundle --platform=node --format=esm --target=node18 \
    --outfile="$OUT/mcpserver.mjs"

# 5. Assets. nextVersion.js and versions.json travel with the corpus so
#    consumers get them checksummed instead of reading a branch.
gzip -9 -c build/mcp/docs.json > "$OUT/docs.json.gz"
cp build/mcp/manifest.json "$OUT/manifest.json"
cp nextVersion.js "$OUT/nextVersion.js"
cp data/versions.json "$OUT/versions.json"

cd "$OUT"
if command -v sha256sum >/dev/null; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
$SUM docs.json.gz manifest.json mcpserver.mjs nextVersion.js versions.json > SHA256SUMS
ls -la
