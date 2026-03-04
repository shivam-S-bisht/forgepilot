# Contributing to ForgePilot

## Project Overview

ForgePilot is a TypeScript CLI tool that automates coding agent interactions with repositories based on Jira tickets. It runs on Node.js 20+ and is bundled with `tsup`.

## Architecture

```
index.ts          → CLI entry point: scope picker → ticket fetch → interactive CLI
mcp-server.ts     → MCP server entry point: exposes all tools via stdio transport
src/
  cli.ts          → Interactive TUI: ticket list, detail view, agent picker, post-agent actions
  ui.ts           → Render functions for all TUI screens (list, details, pickers, prompts)
  jira.ts         → Jira API calls via REST API (fetch tickets, boards, transitions)
  jira-client.ts  → Jira REST API HTTP client (fetch with Basic Auth)
  jira-text.ts    → Ticket text extraction, ADF→plaintext, prompt builder (buildWorkPrompt)
  agents.ts       → Agent detection, runner functions, launchAgentForRepos orchestrator
  git.ts          → Git operations: branch creation, stash, push, MR/PR creation
  repo.ts         → Repo resolution: URL extraction, local scanning, interactive picker
  figma.ts        → Figma API integration: fetch designs, extract tokens, build prompt section
  axon.ts         → Axon knowledge graph: prompt hint injection, watch mode
  preflight.ts    → AI-powered ticket analysis: concern detection, Q&A, caching
  slack.ts        → Slack integration: notifications, threaded Q&A for preflight
  cache.ts        → File-based caching (.cache/ directory, JSON files)
  types.ts        → Shared TypeScript types
```

## Code Style

- **Language**: TypeScript (strict mode, ES2022 target, NodeNext modules)
- **Formatting**: Prettier — single quotes, trailing commas, semicolons, 120 char width
- **Linting**: ESLint with typescript-eslint and prettier integration
- **Imports**: Use `.js` extensions for local imports (NodeNext resolution)
- **Naming**: camelCase for variables/functions, PascalCase for types, UPPER_SNAKE for constants
- **Exports**: Named exports only, no default exports
- **Error handling**: Graceful degradation with `try/catch`, log warnings with `chalk.yellow`, never silent failures
- **Dependencies**: Only `chalk` as a runtime dependency. Everything else is devDependencies.

## Commands

```bash
npm run build         # Bundle with tsup
npm run dev           # Watch mode
npm run lint          # ESLint check
npm run lint:fix      # ESLint auto-fix
npm run format        # Prettier format
npm run format:check  # Prettier check
npm run typecheck     # TypeScript type check (no emit)
npm run link          # Build + npm link for local testing
```

## Conventions

1. **Module boundaries**: Each `src/*.ts` file owns a single concern. Don't mix Jira logic into git.ts or UI logic into agents.ts.
2. **Async functions**: Use `async/await` throughout. No raw `.then()` chains.
3. **Console output**: Use `chalk` for all terminal output. Gray for info, yellow for warnings, green for success, red for errors, cyan for highlights, bold for headings.
4. **Caching**: Use `getCached`/`setCached` from `cache.ts` for any persistent state. Cache keys should be descriptive (e.g. `repoChoice_CE-1234`, `branch-state-CE-1234`).
5. **Environment variables**: All env vars must be prefixed with `FORGEPILOT_`. Access via `process.env.FORGEPILOT_*`.
6. **TUI patterns**: Arrow key navigation with `readline.emitKeypressEvents`. Render functions in `ui.ts`, interaction logic in `cli.ts` or the calling module.
7. **Git operations**: All git commands go through `gitExec()` in `git.ts`. Never call `execFile('git', ...)` directly elsewhere.
8. **No commits**: The CLI must never commit or push on behalf of the user automatically. Push/MR is only triggered by explicit user action (pressing 'p').
9. **Prompt building**: All AI prompt construction happens in `buildWorkPrompt` in `jira-text.ts`. Other modules provide their sections (figma, axon, clarifications) as strings.
10. **Type safety**: Define types in `types.ts` for shared types. Module-local types stay in their own file.

## Adding a New AI Agent

1. Add the runner function in `agents.ts` (e.g. `runNewAgentForTicket`)
2. Add the agent option to `ALL_AGENT_OPTIONS` with its `cli` binary name
3. Add the agent ID to the `WorkAgentOption.id` union in `types.ts`
4. Add the `case` to the switch in `launchAgentForRepos`
5. Detection is automatic — `isCLIAvailable` checks if the binary is in PATH

## Adding a New Environment Variable

1. Use the `FORGEPILOT_` prefix
2. Access it where needed via `process.env.FORGEPILOT_*`
3. Provide a sensible default (never require env vars for core functionality)
4. Document it in the README env variables table
