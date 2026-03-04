# ForgePilot CLI

A dynamic CLI that automates coding agent interactions with your repositories based on Jira tickets. It fetches tickets, resolves local repos, injects rich context (Figma designs, Axon knowledge graphs, contributing guidelines, preflight checks), and launches AI agents to do the work.

## Install

### Local development

```bash
cd ~/dev/repo-agent-cli
npm run build
npm link
```

### Private install via GitHub Packages

Add to `~/.npmrc`:

```ini
@shivam-s-bisht:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_your_read_token
```

Then:

```bash
npm i -g @shivam-s-bisht/forgepilot
```

## Quick Start

```bash
forgepilot
```

This launches the interactive TUI:

1. **Scope picker** — choose "Current Sprint" or "All Assigned Tickets"
2. **Ticket list** — navigate with arrow keys, select with Space, Enter for details
3. **Agent picker** — choose an AI agent to work on the ticket
4. **Post-agent** — push branch, create MR/PR, or retry

## Interactive Controls

### Ticket List

| Key | Action |
|-----|--------|
| Up/Down | Navigate tickets |
| Space | Toggle ticket selection (checkbox) |
| a | Select / deselect all tickets |
| Enter | Open detail view (single) or brief summary (multi) |
| w | Launch agent for selected ticket(s) |
| m | Load more tickets (expand scope) |
| q | Quit |

### Detail View

| Key | Action |
|-----|--------|
| w | Choose AI agent and start work |
| Esc/q | Back to ticket list |

### Post-Agent

| Key | Action |
|-----|--------|
| p | Push branch and create MR/PR |
| r | Retry same agent |
| d | Back to ticket details |
| b | Back to ticket list |

## Multi-Ticket Parallel Execution

Select multiple tickets with **Space**, then press **Enter** or **w**:

- Repos are resolved for all tickets at once
- When two tickets target the same repo, git worktrees provide isolated working directories
- Agents run in parallel with a live dashboard showing progress
- After completion, push branches and create MR/PRs for all successful tickets

## Environment Variables

All ForgePilot-specific variables use the `FORGEPILOT_` prefix. Active configuration is printed at startup.

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_TICKET_SCOPE` | Skip scope picker. `current` or `all` | *(interactive picker)* |
| `FORGEPILOT_DEFAULT_AGENT` | Skip agent picker. Agent ID (see below) | *(interactive picker)* |
| `FORGEPILOT_AUTO_ALL_TICKETS` | `true` to auto-select all tickets for parallel execution | `false` |
| `FORGEPILOT_SKIP_DETAIL` | `true` to skip detail/brief view and launch agent immediately | `false` |
| `FORGEPILOT_BASE_BRANCH` | Base branch to create ticket branches from | `development` |

### Figma

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_FIGMA_PAT` | Figma Personal Access Token for fetching design data | *(Figma skipped)* |
| `FORGEPILOT_JIRA_FIGMA_FIELD` | Custom Jira field ID containing Figma links | *(only description/AC scanned)* |

### Jira

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_JIRA_AC_FIELD` | Custom Jira field ID for Acceptance Criteria | *(AC section omitted)* |

### Axon

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_AXON_VENV_PATH` | Path to Python venv containing axon (e.g. `~/.venvs/axon`) | *(auto-detect from PATH)* |

### Git / Worktrees

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_WORKTREE_DIR` | Directory for git worktrees during parallel execution | `~/.forgepilot-worktrees/` |

### Slack

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_SLACK_WEBHOOK_URL` | Incoming Webhook URL for notifications | *(disabled)* |
| `FORGEPILOT_SLACK_BOT_TOKEN` | Bot OAuth Token for Q&A via threads | *(disabled)* |
| `FORGEPILOT_SLACK_CHANNEL_ID` | Channel ID for bot messages | *(required if bot token set)* |
| `FORGEPILOT_SLACK_USER_ID` | Your Slack user ID for mentions | *(optional)* |

### Fully Hands-Free Mode

Set all three for zero-interaction execution:

```bash
export FORGEPILOT_TICKET_SCOPE="current"
export FORGEPILOT_DEFAULT_AGENT="copilot-autonomous"
export FORGEPILOT_AUTO_ALL_TICKETS="true"
```

This fetches current sprint tickets, selects all, and launches the agent in parallel. Suitable for cron jobs or CI.

## Supported AI Agents

ForgePilot auto-detects which CLI tools are installed on your system:

| Agent ID | CLI Binary | Description |
|----------|-----------|-------------|
| `copilot-autonomous` | `copilot` | Non-interactive with auto approvals |
| `copilot-interactive` | `copilot` | Chat mode with prompt prefilled |
| `claude-code-autonomous` | `claude` | Print mode with prompt |
| `claude-code-interactive` | `claude` | Interactive session with prompt |
| `cursor-autonomous` | `cursor` | Cursor agent in yolo mode |
| `gemini-autonomous` | `gemini` | Gemini CLI in print mode |
| `codex-full-auto` | `codex` | OpenAI Codex with --full-auto |
| `codex-autonomous` | `codex` | OpenAI Codex with --yolo |
| `aider-autonomous` | `aider` | Aider with --message and --yes |
| `opencode-autonomous` | `opencode` | OpenCode with prompt flag |
| `cline-autonomous` | `cline` | Cline with --yolo auto-approval |
| `rovo-autonomous` | `acli` | Atlassian Rovo in yolo mode |

## What ForgePilot Does

When you select a ticket and launch an agent, ForgePilot:

1. **Resolves repositories** — extracts repo URLs from the Jira ticket description, matches them to local repos under your root directory, or presents a TUI picker
2. **Prepares the repo** — stashes changes, fetches latest, checks out base branch, creates a ticket branch (e.g. `CE-1234`)
3. **Runs preflight checks** — AI-powered analysis of the ticket for potential concerns, with Q&A via Slack or terminal
4. **Fetches Figma designs** — if Figma links are found, fetches node structure, rendered images, and design tokens
5. **Injects Axon context** — if an Axon knowledge graph exists in the repo, adds structural reasoning protocol to the prompt
6. **Builds a rich prompt** — structured with role, task, workflow steps, ticket context, constraints, contributing guidelines, design context, and clarifications
7. **Launches the AI agent** — in the repo directory with the full prompt
8. **Transitions the ticket** — marks it "In Progress" in Jira
9. **Notifies Slack** — sends status updates on start, completion, or failure
10. **Post-agent options** — push branch, create MR/PR (auto-detects GitHub/GitLab), retry, or go back

## Release Flow

Uses `standard-version` for SemVer + changelog:

```bash
npm run release        # bump version + CHANGELOG.md + git tag
git push && git push --tags
```

GitHub Actions publishes to GitHub Packages when a `v*` tag is pushed.

## Development

```bash
npm run build          # build with tsup
npm run dev            # watch mode
npm run lint           # eslint
npm run format         # prettier
npm run typecheck      # tsc --noEmit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture and code conventions.
