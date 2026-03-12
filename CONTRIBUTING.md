# Contributing to Meshimize MCP Server

## Development Setup

Clone the repository:

```bash
git clone https://github.com/renl/meshimize-mcp.git
cd meshimize-mcp
npm install
```

## Commands

```bash
npm run typecheck    # Type check
npm run lint         # Lint
npm run format       # Format (Prettier)
npm run format:check # Check formatting
npm test             # Run tests (Vitest)
npm run build        # Build
npm start            # Start server
```

## Before Submitting

1. Run `npm run format` to format all files
2. Run `npm run lint` to check for lint errors
3. Run `npm run typecheck` to verify types
4. Run `npm test` to run the test suite
5. Run `npm run build` to confirm the build succeeds

## Project Structure

```
src/
├── api/          # REST API client
├── buffer/       # Local message buffer
├── config.ts     # Environment variable configuration
├── index.ts      # Entry point
├── state/        # Pending join state management
├── tools/        # MCP tool handlers (groups, messages, direct messages)
└── ws/           # WebSocket client (Phoenix Channels)
tests/            # Vitest test files
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
