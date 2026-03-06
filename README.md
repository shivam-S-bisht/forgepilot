# ForgePilot CLI

A dynamic CLI that automates coding agent interactions with your repositories based on Jira tickets. It fetches tickets, resolves local repos, injects rich context (Figma designs, Axon knowledge graphs, contributing guidelines, preflight checks), and launches AI agents to do the work.

## How It Works

The diagram below shows the end-to-end workflow for both the CLI and MCP Server.

```mermaid
flowchart TD
    subgraph entryPoints [Entry Points]
        CLI["forgepilot CLI"]
        MCP["forgepilot-mcp Server"]
    end

    subgraph scopeSelection [Scope Selection]
        Scope{"Ticket Scope"}
        CurrentSprint["Current Sprint"]
        AllAssigned["All Assigned"]
    end

    subgraph ticketFlow [Ticket Processing]
        FetchTickets["Fetch Jira Tickets"]
        TicketList["Interactive Ticket List / Auto-Select"]
        LoadDetails["Load Ticket Details"]
    end

    subgraph contextGathering [Context Gathering]
        ResolveRepos["Resolve Local Repositories"]
        PrepareBranch["Prepare Branch (stash, fetch, checkout, create)"]
        Preflight["Preflight Checks (AI Analysis)"]
        FigmaCtx["Fetch Figma Designs"]
        AxonCtx["Fetch Axon Knowledge Graph"]
        Guidelines["Read Contributing Guidelines"]
    end

    subgraph agentExecution [Agent Execution]
        BuildPrompt["Build Structured Prompt"]
        PickAgent["Select AI Agent"]
        LaunchAgent["Launch Agent in Repo"]
    end

    subgraph postAgent [Post-Agent Actions]
        TransitionJira["Transition Ticket to In Progress"]
        NotifySlack["Notify Slack"]
        PushBranch["Push Branch"]
        CreatePR["Create MR / PR"]
    end

    CLI --> Scope
    MCP --> FetchTickets
    Scope --> CurrentSprint --> FetchTickets
    Scope --> AllAssigned --> FetchTickets
    FetchTickets --> TicketList --> LoadDetails
    LoadDetails --> ResolveRepos
    ResolveRepos --> PrepareBranch
    PrepareBranch --> Preflight
    Preflight --> FigmaCtx
    FigmaCtx --> AxonCtx
    AxonCtx --> Guidelines
    Guidelines --> BuildPrompt
    BuildPrompt --> PickAgent
    PickAgent --> LaunchAgent
    LaunchAgent --> TransitionJira
    TransitionJira --> NotifySlack
    NotifySlack --> PushBranch
    PushBranch --> CreatePR
```

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
| `FORGEPILOT_SKIP_DETAIL` | `true` to skip posting ticket description/AC to Slack and skip detail view in TUI | `false` |
| `FORGEPILOT_AUTO_PUSH` | `true` to auto-push branch and create MR/PR after agent finishes (skips Slack/TUI prompt) | `false` |
| `FORGEPILOT_BASE_BRANCH` | Base branch to create ticket branches from | `development` |

### Figma

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_FIGMA_PAT` | Figma Personal Access Token for fetching design data | *(Figma skipped)* |
| `FORGEPILOT_JIRA_FIGMA_FIELD` | Custom Jira field ID containing Figma links | *(only description/AC scanned)* |

### Jira

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_JIRA_BASE_URL` | Jira instance URL (e.g. `https://mycompany.atlassian.net`) | **Required** |
| `FORGEPILOT_JIRA_EMAIL` | Atlassian account email for API auth | **Required** |
| `FORGEPILOT_JIRA_API_TOKEN` | Jira API token ([create one here](https://id.atlassian.com/manage-profile/security/api-tokens)) | **Required** |
| `FORGEPILOT_JIRA_AC_FIELD` | Custom Jira field ID for Acceptance Criteria | *(AC section omitted)* |

### Axon

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_AXON_VENV_PATH` | Path to Python venv containing axon (e.g. `~/.venvs/axon`) | *(auto-detect from PATH)* |

### Git / Worktrees

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_WORKTREE_DIR` | Directory for git worktrees during parallel execution | `~/.forgepilot-worktrees/` |
| `FORGEPILOT_GITHUB_TOKEN` | GitHub Personal Access Token for creating PRs via API (used when `gh` CLI is not installed) | *(falls back to manual URL)* |
| `FORGEPILOT_GITLAB_TOKEN` | GitLab Personal Access Token for creating MRs via API (used when `glab` CLI is not installed) | *(falls back to manual URL)* |

### Slack

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_SLACK_QA` | Set to `true` to enable Slack-driven workflow (replaces TUI) | `false` |
| `FORGEPILOT_SLACK_WEBHOOK_URL` | Incoming Webhook URL for notifications | *(disabled)* |
| `FORGEPILOT_SLACK_BOT_TOKEN` | Bot OAuth Token for Q&A via threads | *(disabled)* |
| `FORGEPILOT_SLACK_CHANNEL_ID` | Channel ID for bot messages | *(required if bot token set)* |
| `FORGEPILOT_SLACK_USER_ID` | Your Slack user ID for mentions | *(optional)* |
| `FORGEPILOT_SLACK_EXPECTED_USER_ID` | Only accept replies from this Slack user ID | *(any user)* |
| `FORGEPILOT_SLACK_POLL_INTERVAL_MS` | How often to poll for Slack replies (ms) | `5000` |
| `FORGEPILOT_SLACK_ANSWER_TIMEOUT_MS` | Timeout waiting for Slack replies (ms) | `600000` (10 min) |

### Slack-Driven Workflow

When `FORGEPILOT_SLACK_QA=true` with `FORGEPILOT_SLACK_BOT_TOKEN` and `FORGEPILOT_SLACK_CHANNEL_ID` set, ForgePilot replaces the terminal TUI with a fully Slack-driven workflow:

1. **Scope selection** — bot posts numbered options, you reply with a number
2. **Ticket selection** — bot lists tickets, you reply with number(s) (comma-separated for multi-select)
3. **Agent selection** — bot lists available agents, you reply with a number
4. **Repo selection** — if repos can't be auto-resolved, bot lists local repos for you to pick
5. **Mid-work Q&A** — if the agent has questions, they're routed to Slack
6. **Post-agent actions** — bot offers push/MR, retry, or done

All interactions happen via thread replies. The terminal shows verbose progress logs for every step.

Set `FORGEPILOT_AUTO_PUSH=true` to skip the post-agent prompt and automatically push branches and create MR/PRs. Set `FORGEPILOT_SKIP_DETAIL=true` to skip posting ticket description/AC to Slack before agent launch.

```bash
export FORGEPILOT_SLACK_QA="true"
export FORGEPILOT_SLACK_BOT_TOKEN="xoxb-your-bot-token"
export FORGEPILOT_SLACK_CHANNEL_ID="C0123456789"
export FORGEPILOT_SLACK_EXPECTED_USER_ID="U0123456789"  # optional
forgepilot
```

### Fully Hands-Free Mode

Set Jira credentials and automation flags for zero-interaction execution:

```bash
export FORGEPILOT_JIRA_BASE_URL="https://mycompany.atlassian.net"
export FORGEPILOT_JIRA_EMAIL="you@company.com"
export FORGEPILOT_JIRA_API_TOKEN="ATATT3x..."
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

## MCP Server

ForgePilot includes an MCP (Model Context Protocol) server that exposes all its capabilities as tools for AI agents like Cursor, Claude Desktop, Copilot, and others.

### Available Tools

| Tool | Description |
|------|-------------|
| `list_tickets` | Fetch tickets by scope (current sprint / all assigned) |
| `search_tickets` | Run a custom JQL query |
| `get_ticket_details` | Full ticket details (description, AC, comments, links) |
| `transition_ticket` | Move a ticket to "In Progress" |
| `get_boards` | List all visible Jira boards |
| `list_local_repos` | Scan a directory for git repositories |
| `resolve_repos` | Match ticket repo URLs to local repos |
| `prepare_branch` | Stash, fetch, checkout base, create ticket branch |
| `get_branch_status` | Current branch, uncommitted changes, recent commits |
| `commit_changes` | Stage and commit changes |
| `push_and_create_pr` | Push branch and create PR/MR (auto-detects GitHub/GitLab) |
| `get_figma_context` | Fetch Figma design data for a ticket |
| `get_axon_context` | Get Axon knowledge graph hint for a repo |
| `get_contributing_guidelines` | Read CONTRIBUTING.md / AGENTS.md from a repo |
| `build_prompt` | Build the full structured AI prompt for a ticket |
| `cache_get` | Read a value from the ForgePilot cache |
| `cache_set` | Write a value to the cache |
| `cache_list` | List all cached keys and values |
| `cache_clear` | Clear the entire cache |
| `work_on_ticket` | All-in-one: resolve repos, prepare branches, build prompt, transition ticket |

### Setup for Cursor

Add to `.cursor/mcp.json` in your project or global config:

```json
{
  "mcpServers": {
    "forgepilot": {
      "command": "forgepilot-mcp"
    }
  }
}
```

### Setup for Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forgepilot": {
      "command": "forgepilot-mcp"
    }
  }
}
```

The MCP server uses the same `FORGEPILOT_*` environment variables as the CLI. Make sure `FORGEPILOT_JIRA_BASE_URL`, `FORGEPILOT_JIRA_EMAIL`, and `FORGEPILOT_JIRA_API_TOKEN` are set in your shell environment.

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
