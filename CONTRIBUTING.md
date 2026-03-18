# Contributing to ForgePilot

## Project Overview

ForgePilot is a TypeScript CLI tool that automates coding agent interactions with repositories based on Jira tickets. It runs on Node.js 20+ and is bundled with `tsup`.

## Architecture

```
index.ts          → CLI entry point: work mode picker (ticket / custom) → scope picker → ticket fetch → interactive CLI
mcp-server.ts     → MCP server entry point: exposes all tools via stdio transport (including background job management)
src/
  core/
    cli.ts        → Interactive TUI: ticket list, detail view, agent picker, job list, log viewer
    ui.ts         → Render functions for all TUI screens (list, details, pickers, prompts, job list, log viewer)
    agents.ts     → Agent detection, runner functions, background launch (launchAgentInBackground),
                    plan generation (generateTodoPlan, generateCustomTodoPlan),
                    plan review (reviewTodoPlan, reviewCustomTodoPlan),
                    clarifying questions (askCustomTaskClarifications),
                    multi-ticket parallel launch
    cache.ts      → File-based caching (.cache/ directory, JSON files)
    job-manager.ts→ Background job tracking: register, update, query, stop, cleanup stale jobs
  tools/
    jira/
      jira.ts       → Jira API calls via REST API (fetch tickets, boards, transitions)
      jira-client.ts→ Jira REST API HTTP client (fetch with Basic Auth)
      jira-text.ts  → Ticket text extraction, ADF→plaintext, prompt builder (buildWorkPrompt, buildCustomTaskPrompt)
    git/
      git.ts        → Git operations: branch creation, stash, push, MR/PR creation
    repo/
      repo.ts       → Repo resolution: URL extraction, local scanning, interactive picker
    figma/
      figma.ts      → Figma API integration: fetch designs, extract tokens, build prompt section
    axon/
      axon.ts       → Axon knowledge graph: prompt hint injection, watch mode
    preflight/
      preflight.ts  → AI-powered ticket analysis: concern detection, Q&A, caching
    slack/
      slack.ts      → Slack integration: notifications, threaded Q&A for preflight
    voice/
      voice.ts      → Voice mode: push-to-talk loop, AI command parsing, command handlers (including job management)
      voice-commands.ts → Voice command definitions and keyword/phrase patterns
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
- **Dependencies**: Minimal runtime dependencies (`chalk`, `sherpa-onnx-node` for voice). Keep the dependency footprint small.

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

1. **Module boundaries**: Each source file owns a single concern. Don't mix Jira logic into git.ts or UI logic into agents.ts.
2. **Async functions**: Use `async/await` throughout. No raw `.then()` chains.
3. **Console output**: Use `chalk` for all terminal output. Gray for info, yellow for warnings, green for success, red for errors, cyan for highlights, bold for headings.
4. **Caching**: Use `getCached`/`setCached` from `cache.ts` for any persistent state. Cache keys should be descriptive (e.g. `repoChoice_CE-1234`, `branch-state-CE-1234`).
5. **Environment variables**: All env vars must be prefixed with `FORGEPILOT_`. Access via `process.env.FORGEPILOT_*`.
6. **TUI patterns**: Arrow key navigation with `readline.emitKeypressEvents`. Render functions in `ui.ts`, interaction logic in `cli.ts` or the calling module. The TUI has multiple modes (ticket list, job list, log viewer) tracked by boolean state flags.
7. **Git operations**: All git commands go through `gitExec()` in `git.ts`. Never call `execFile('git', ...)` directly elsewhere.
8. **No auto-push**: The CLI must never push on behalf of the user automatically. Push/MR is only triggered by explicit user action (pressing 'p').
9. **Prompt building**: AI prompt construction happens in `buildWorkPrompt` (tickets) and `buildCustomTaskPrompt` (custom tasks) in `jira-text.ts`. Other modules provide their sections (figma, axon, clarifications) as strings.
10. **Type safety**: Define types in `types.ts` for shared types. Module-local types stay in their own file.
11. **Background agents**: All agent launches use `launchAgentInBackground` which spawns detached processes. Never block the TUI waiting for an agent to finish. Job state is tracked via `job-manager.ts`.
12. **Plan generation**: Both ticket and custom task flows generate a todo plan for user review before launching the agent. Plan review supports approve, modify, restart, and skip.
13. **Commit hygiene**: The MCP `commit_changes` tool strips `Co-authored-by`, `Signed-off-by`, and other trailers from commit messages before committing. The prompt also instructs agents not to add trailers.

## Adding a New AI Agent

1. Add the runner function in `agents.ts` (e.g. `runNewAgentForTicket`)
2. Add the agent option to `ALL_AGENT_OPTIONS` with its `cli` binary name
3. Add the agent ID to the `WorkAgentOption.id` union in `types.ts`
4. Add the `case` to `resolveAgentCommand` in `agents.ts` (maps agent option to command/args)
5. Detection is automatic — `isCLIAvailable` checks if the binary is in PATH

## Adding a New Environment Variable

1. Use the `FORGEPILOT_` prefix
2. Access it where needed via `process.env.FORGEPILOT_*`
3. Provide a sensible default (never require env vars for core functionality)
4. Document it in the README env variables table

## Adding a New Voice Command

1. Add a `VoiceCommand` entry to `VOICE_COMMANDS` in `voice-commands.ts` with phrases and parameter extractors
2. Add the handler function in `voice.ts`
3. Register the handler in the `COMMAND_HANDLERS` map in `voice.ts`

## Adding a New MCP Tool

1. Define the tool in `mcp-server.ts` using `server.tool(name, description, schema, handler)`
2. Document it in the README MCP tools table
3. For background job tools, use functions from `job-manager.ts`

## Background Job Lifecycle

Jobs transition through these states: `running` → `done` | `failed` | `stopped`.

- `registerJob()` creates a job record when an agent is spawned
- `updateJob()` updates status when the process exits or is killed
- `cleanupStaleJobs()` detects dead PIDs on startup and marks them as failed
- Job records persist in `.cache/jobs.json`
- Log files are stored in `.cache/logs/<jobId>.log`
