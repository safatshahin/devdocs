# Moodle Developer Resources

<p align="center">
  {/* <!--<a href="CONTRIBUTING.md#pull-requests"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>--> */}
  {/* <!--<a href="#license"><img src="https://img.shields.io/github/license/sourcerer-io/hall-of-fame.svg?colorB=ff0000"></a>--> */}
  <a href="https://gitpod.io/#https://github.com/moodle/devdocs"><img src="https://img.shields.io/badge/Gitpod-Ready--to--Code-blue?logo=gitpod" alt="Gitpod Ready-to-Code"/></a>
  <a href="https://meercode.io/moodle/devdocs"><img src="https://meercode.io/badge/moodle/devdocs?type=ci-score" alt="CI Score"></a>
  <a href="https://github.com/moodle/devdocs/actions/workflows/markdown-lint.yml"><img src="https://github.com/moodle/devdocs/actions/workflows/markdown-lint.yml/badge.svg" alt="Lint status"></a>
  <a href="https://github.com/moodle/devdocs/actions/workflows/pages/pages-build-deployment"><img src="https://github.com/moodle/devdocs/actions/workflows/pages/pages-build-deployment/badge.svg" alt="Build status"></a>
  <a href="https://github.com/moodle/devdocs/actions/workflows/deploy.yml"><img src="https://github.com/moodle/devdocs/actions/workflows/deploy.yml/badge.svg" alt="Build status"></a>
</p>

## Introduction

This repository includes the source for the Moodle Developer Resources - a
collection of resources aimed at making your life as a Moodle Developer easier.

## Contributing

These resources are written by developers, for developers. We value your input
and your help in adding to them.

There are many ways that you can help, from reporting inaccuracies, and missing
documentation, to making small corrections and, of course, creating new
resources for others to make use of.

If you plan to contribute, then you may wish to setup a local development
environment to make it easier to do so.

We highly recommend that you read our [documentation contributions guide](https://moodledev.io/general/documentation/contributing), which includes important information on [getting started](https://moodledev.io/general/documentation/contributing#getting-started).

### Installation

For more information on the installation process see our [installation documentation](https://moodledev.io/general/documentation/installation), but if you want to jump right in then the easiest way is using [NVM](https://github.com/nvm-sh/nvm) and then running:

```
nvm install
npm i -g yarn
yarn
yarn start
```

### Building your content

During development you will almost certainly want to use the yarn development server, however you will sometimes need to build the content to use certain
features.

This is easily achieved with yarn:

```
yarn build
```

This command will compile all of the documentation into static HTML files complete with all appropriate resources.

As part of this build, the validity of all internal links will be checked. For this reason we strongly recommend building the content locally before submitting a pull request as broken internal links will lead to a build failure
immediately.

You may also need to configure the build to view it locally. This can be achieved using a `.env` file in the project root. For more information on the format of the `.env` file, see the documentation in the `.env.default` file.

### MCP server for AI agents

After running `yarn build`, the docs corpus for the MCP (Model Context Protocol) server is generated in `build/mcp/` (by the `docusaurus-plugin-mcp-server` postBuild hook, used for artifact generation only). `mcpserver.mjs` is a self-contained server over that corpus with BM25 relevance ranking (OR semantics, prefix matching), one result per page across doc versions (newest preferred; a `version` argument selects another, `"all"` disables collapsing), and section-level fetching: append `#<anchor>` to a page URL (anchors are shown in search results) to retrieve one section instead of a whole page - large pages return a table of contents unless `full=true` is passed.

Start the local MCP server:

```
node mcpserver.mjs
```

The server runs at `http://localhost:3001/mcp` (env `PORT` and `DOCS_DIR` override the defaults). Connect your AI agent using the instructions below.

#### Claude Code

```
claude mcp add --transport http moodle-docs http://localhost:3001/mcp
```

#### GitHub Copilot (VS Code)

Add to your `.vscode/mcp.json`, or create it if it doesn't exist:

```json
{
  "servers": {
    "moodle-docs": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

#### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "moodle-docs": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

#### OpenCode

Add to your `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "moodle-docs": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

#### Codex (OpenAI Codex CLI)

```
codex mcp add --name moodle-docs --url http://localhost:3001/mcp
```
