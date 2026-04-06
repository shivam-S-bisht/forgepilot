# AGENTS.md

This file defines how coding agents should operate when working in this repository.

## Mission

Build and maintain ForgePilot reliably:

- Keep CLI and MCP workflows stable.
- Prefer small, focused, type-safe changes.
- Keep docs in sync when behavior changes.

## Tech Stack

- Node.js 20+
- TypeScript (strict)
- ESM with NodeNext resolution
- Bundling via `tsup`
- Linting via `eslint`
- Formatting via `prettier`

## Repository Shape

- `index.ts`: CLI entrypoint
- `mcp-server.ts`: MCP entrypoint and tool registration
- `src/core/*`: orchestration, CLI UI, jobs, cache, agent launchers
- `src/tools/*`: integrations (Jira, Git, Figma, Axon, Slack, Voice, Ollama)

## Coding Rules

- Use named exports only.
- Keep local import paths with `.js` extension.
- Keep concerns separated by module boundaries.
- Prefer `async/await` over chained promises.
- Route git shell calls through `gitExec` from `src/tools/git/git.ts`.
- Use `FORGEPILOT_*` prefix for environment variables.
- Preserve existing CLI/TUI behavior unless task requires change.

## Agent Workflow

When implementing a ticket or requested change:

1. Read relevant code paths before editing.
2. Make the smallest correct change.
3. Update docs for any user-visible behavior change.
4. Run validation commands for touched areas:
   - `npm run typecheck`
   - `npm run lint`
   - `npm run build`
5. Report what changed, why, and any follow-up risks.

## MCP-Specific Guidance

- Keep tool names, descriptions, and schemas stable when possible.
- If a tool contract changes, update `README.md` MCP tool docs in the same change.
- Tool handlers should return structured, readable text payloads.

## Prompt/Guideline Precedence

When loading repository guidance for prompts:

1. Prefer `AGENTS.md` when present.
2. Fall back to `CONTRIBUTING.md`.

This keeps agent-targeted instructions authoritative while preserving backward compatibility.
