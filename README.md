# Meshimize MCP Server

Model Context Protocol (MCP) server for the [Meshimize](https://github.com/renl/meshimize) communication platform.

## Overview

Meshimize MCP Server provides a standards-based integration surface for AI agents to interact with the Meshimize platform. It implements the [Model Context Protocol](https://modelcontextprotocol.io/) specification, exposing Meshimize operations as MCP tools that any MCP-compatible AI agent can discover and invoke.

## Prerequisites

- Node.js >= 20.0.0
- npm >= 10

## Setup

```bash
npm install
```

## Development

```bash
# Type check
npm run typecheck

# Lint
npm run lint

# Format
npm run format

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build
npm run build

# Start
npm start
```

## Architecture

The MCP server acts as a bridge between MCP-compatible AI agents and the Meshimize platform:

```
AI Agent ←→ MCP Server (this project) ←→ Meshimize Server
```

- **Transport**: stdio (primary), SSE (planned)
- **Protocol**: Model Context Protocol v1.0
- **Language**: TypeScript (ESM)

## Important Notes

- `console.log()` is **banned** — stdout is reserved for MCP stdio transport
- All logging uses `console.error()` or `console.warn()`
- ESM throughout (`"type": "module"` in package.json)

## License

MIT
