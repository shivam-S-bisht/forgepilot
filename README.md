# ForgePilot CLI

A dynamic CLI that automates coding agent interactions with your repositories based on Jira tickets. It fetches tickets, resolves local repos, injects rich context (Figma designs, Axon knowledge graphs, contributing guidelines, preflight checks), and launches AI agents to do the work.

## How It Works

The diagram below shows the end-to-end workflow for both the CLI and MCP Server.

```mermaid
flowchart TD
    subgraph entryPoints [Entry Points]
        CLI["forgepilot CLI"]
        MCP["forgepilot-mcp Server"]
        Voice["forgepilot --voice (AI-parsed)"]
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
    Voice -->|"push-to-talk"| FetchTickets
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

## Getting Started (New System Setup)

Follow these steps to install and configure ForgePilot from scratch on a new machine.

### Step 1 — Prerequisites

- **macOS** (voice mode requires macOS `say` for TTS)
- **Node.js 20+**
- **Git**
- **Homebrew** — <https://brew.sh>

### Step 2 — Install ForgePilot

**Option A — Global install via GitHub Packages (recommended):**

Add to `~/.npmrc`:

```ini
@shivam-s-bisht:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_your_read_token
```

Then install globally:

```bash
npm i -g @shivam-s-bisht/forgepilot
```

**Option B — From source:**

```bash
git clone <repo-url> ~/dev/repo-agent-cli
cd ~/dev/repo-agent-cli
npm install
npm run build
npm link
```

### Step 3 — Configure Jira (Required)

Add these to your `~/.zshrc` (or `~/.bashrc`):

```bash
export FORGEPILOT_JIRA_BASE_URL="https://yourcompany.atlassian.net"
export FORGEPILOT_JIRA_EMAIL="you@company.com"
export FORGEPILOT_JIRA_API_TOKEN="ATATT3x..."   # https://id.atlassian.com/manage-profile/security/api-tokens
export FORGEPILOT_ROOT_DIR="~/dev"               # root directory where your repos live
```

Reload your shell (`source ~/.zshrc`) after adding these.

### Step 4 — Install an AI Agent CLI

ForgePilot launches external AI agents to do the actual coding work. Install at least one:

| Agent | Install Command |
|-------|-----------------|
| GitHub Copilot CLI | `npm i -g @githubnext/github-copilot-cli` |
| Claude Code | `npm i -g @anthropic-ai/claude-code` |
| Cursor CLI | Comes with Cursor IDE |
| Gemini CLI | `npm i -g @google/gemini-cli` |
| Aider | `pip install aider-chat` |
| OpenAI Codex | `npm i -g @openai/codex` |

ForgePilot auto-detects which are installed and only shows available options. See [Supported AI Agents](#supported-ai-agents) for the full list of agent IDs.

### Step 5 — Set Optional Automation Variables

These are not required but streamline the workflow:

```bash
# Skip interactive pickers
export FORGEPILOT_DEFAULT_AGENT="copilot-autonomous"
export FORGEPILOT_TICKET_SCOPE="current"            # "current" or "all"
export FORGEPILOT_BASE_BRANCH="development"          # base branch for ticket branches
export FORGEPILOT_AUTO_PUSH="true"                   # auto-push + create PR after agent finishes

# Git platform tokens (for PR/MR creation without gh/glab CLI)
export FORGEPILOT_GITHUB_TOKEN="ghp_..."
export FORGEPILOT_GITLAB_TOKEN="glpat-..."

# Figma design context (optional)
export FORGEPILOT_FIGMA_PAT="figd_..."

# Slack-driven workflow (optional — see Slack-Driven Workflow section below)
export FORGEPILOT_SLACK_QA="true"
export FORGEPILOT_SLACK_BOT_TOKEN="xoxb-..."
export FORGEPILOT_SLACK_CHANNEL_ID="C0123456789"
```

See [Environment Variables](#environment-variables) for the complete reference.

### Step 6 — Set Up Voice Mode (Optional)

1. Install `sox` for microphone recording:

```bash
brew install sox
```

2. The Whisper model is **auto-downloaded** on first use. The default model is `large-v3` (~1.7 GB) for best accuracy. To use a smaller/faster model, set `FORGEPILOT_VOICE_MODEL`:

```bash
export FORGEPILOT_VOICE_MODEL="large-v3"    # best accuracy (default, ~1.7 GB)
# export FORGEPILOT_VOICE_MODEL="medium.en"  # good balance (~945 MB)
# export FORGEPILOT_VOICE_MODEL="small.en"   # faster (~200 MB)
# export FORGEPILOT_VOICE_MODEL="tiny.en"    # fastest, lowest accuracy (~98 MB)
```

3. Ensure at least one AI agent CLI is installed (from Step 4) — voice mode uses `copilot` or `cursor` for AI-powered command parsing. Set `FORGEPILOT_PREFLIGHT_AGENT=cursor` if you prefer Cursor over Copilot.

Speech recognition runs entirely offline via `sherpa-onnx-node` — no API keys needed. Models are stored in `~/.forgepilot/sherpa-models/`. See [Voice Mode](#voice-mode) for full usage details.

### Step 7 — Set Up MCP Server (Optional)

The MCP server exposes ForgePilot as tools for AI editors.

**For Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "forgepilot": {
      "command": "forgepilot-mcp"
    }
  }
}
```

**For Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forgepilot": {
      "command": "forgepilot-mcp"
    }
  }
}
```

See [MCP Server](#mcp-server) for the full list of available tools.

### Step 8 — Verify

```bash
forgepilot              # interactive TUI
forgepilot --voice      # voice mode (requires Step 6)
forgepilot-mcp          # MCP server (should start without errors)
```

### Quick Reference — All Environment Variables

```bash
# Jira (required)
export FORGEPILOT_JIRA_BASE_URL="https://yourcompany.atlassian.net"
export FORGEPILOT_JIRA_EMAIL="you@company.com"
export FORGEPILOT_JIRA_API_TOKEN="ATATT3x..."
export FORGEPILOT_ROOT_DIR="~/dev"

# Automation (optional)
export FORGEPILOT_DEFAULT_AGENT="copilot-autonomous"
export FORGEPILOT_TICKET_SCOPE="current"
export FORGEPILOT_BASE_BRANCH="development"
export FORGEPILOT_AUTO_PUSH="true"
export FORGEPILOT_AUTO_ALL_TICKETS="false"
export FORGEPILOT_SKIP_DETAIL="false"

# Git platform tokens (optional)
export FORGEPILOT_GITHUB_TOKEN="ghp_..."
export FORGEPILOT_GITLAB_TOKEN="glpat-..."

# Figma (optional)
export FORGEPILOT_FIGMA_PAT="figd_..."

# Voice (optional)
export FORGEPILOT_VOICE_TTS="say"
export FORGEPILOT_VOICE_MODEL="large-v3"         # tiny.en | small.en | medium.en | large-v3
export FORGEPILOT_PREFLIGHT_AGENT="copilot"

# Local Ollama (optional)
export FORGEPILOT_OLLAMA_MODEL="qwen2.5-coder:7b" # model to use with ollama-local agent
export FORGEPILOT_OLLAMA_API_BASE="http://127.0.0.1:11434"  # Ollama API endpoint

# Slack (optional)
export FORGEPILOT_SLACK_QA="true"
export FORGEPILOT_SLACK_BOT_TOKEN="xoxb-..."
export FORGEPILOT_SLACK_CHANNEL_ID="C0123456789"
export FORGEPILOT_SLACK_EXPECTED_USER_ID="U0123456789"
```

---

## Install

### System Dependencies (optional)

For **voice mode**, install `sox` (audio recording):

```bash
brew install sox
```

Then download the Whisper speech-to-text model (~98 MB total):

```bash
mkdir -p ~/.forgepilot/sherpa-models/whisper-tiny.en
cd ~/.forgepilot/sherpa-models/whisper-tiny.en
curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-encoder.int8.onnx
curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-decoder.int8.onnx
curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-tokens.txt
```

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

1. **Work mode** — choose "Work on a Jira ticket" or "Work from a description" (custom task)
2. **Scope picker** (ticket mode) — choose "Current Sprint" or "All Assigned Tickets"
3. **Ticket list** — navigate with arrow keys, select with Space, Enter for details
4. **Clarifying questions & plan review** — AI asks questions and proposes a task plan for your approval
5. **Agent launch** — agent runs in the background; TUI returns immediately
6. **Jobs dashboard** — press **l** to monitor running agents, view logs, stop, or retry

## Interactive Controls

### Ticket List

| Key | Action |
|-----|--------|
| Up/Down | Navigate tickets |
| Space | Toggle ticket selection (checkbox) |
| a | Select / deselect all tickets |
| Enter | Open detail view (single) or brief summary (multi) |
| w | Launch agent for selected ticket(s) |
| l | Open background jobs list |
| m | Load more tickets (expand scope) |
| q | Quit |

Tickets with active background agents show status badges: **AI Working**, **AI Done**, **AI Failed**, or **Stopped**. The list auto-refreshes every 5 seconds.

### Detail View

| Key | Action |
|-----|--------|
| w | Choose AI agent and start work |
| Esc/q | Back to ticket list |

### Background Jobs List

Press **l** from the ticket list to view all background agent jobs.

| Key | Action |
|-----|--------|
| Up/Down | Navigate jobs |
| Enter | Open live log viewer for selected job |
| Esc/q | Back to ticket list |

### Log Viewer

| Key | Action |
|-----|--------|
| s | Stop a running agent |
| r | Retry/resume a failed or stopped agent |
| Esc/q | Back to jobs list |

Logs auto-refresh every 2 seconds while viewing.

## Background Agent Execution

All agent launches (single-ticket and multi-ticket) run in the background. The TUI returns immediately so you can continue browsing tickets, launch more agents, or view logs.

- Agents are spawned as detached child processes with output piped to log files
- Job state is persisted to `.cache/jobs.json` and survives CLI restarts
- Stale jobs (dead PIDs) are cleaned up automatically on startup
- Press **l** to view all jobs, Enter to tail logs, **s** to stop, **r** to retry

### Multi-Ticket Parallel Execution

Select multiple tickets with **Space**, then press **Enter** or **w**:

- Repos are resolved for all tickets at once
- Each ticket's agent is launched in the background independently
- When two tickets target the same repo, git worktrees provide isolated working directories
- Status badges on the ticket list show real-time progress

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

### Local Ollama

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_OLLAMA_MODEL` | Ollama model to use with the `ollama-local` agent | *(interactive picker)* |
| `FORGEPILOT_OLLAMA_API_BASE` | Ollama API endpoint | `http://127.0.0.1:11434` |

The `ollama-local` agent uses [aider](https://aider.chat/) to drive a locally-running Ollama model. ForgePilot auto-detects both CLIs, starts `ollama serve` if needed, and provides a TUI model picker. No cloud API keys required.

**Prerequisites:** `brew install ollama` and `pip install aider-chat` (or `pipx install aider-chat`).

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

### Voice Mode

ForgePilot includes a fully hands-free push-to-talk voice interface with AI-powered natural language understanding. Speak naturally and ForgePilot figures out what you want — no memorizing exact phrases.

#### Prerequisites

1. **sox** (audio recording):

```bash
brew install sox
```

2. **Whisper speech-to-text model** (~98 MB total):

```bash
mkdir -p ~/.forgepilot/sherpa-models/whisper-tiny.en
cd ~/.forgepilot/sherpa-models/whisper-tiny.en
curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-encoder.int8.onnx
curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-decoder.int8.onnx
curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-tokens.txt
```

3. **AI agent CLI** (for intelligent command parsing — at least one of):
   - `copilot` (GitHub Copilot CLI) — **recommended**, used by default
   - `cursor` (Cursor CLI) — set `FORGEPILOT_PREFLIGHT_AGENT=cursor` to use

Speech recognition runs entirely in-process via `sherpa-onnx-node` (OpenAI Whisper as a Node.js addon) — completely free, no API keys, fully offline. The AI command parser uses the same agent CLI as preflight checks. If no AI CLI is available, voice mode falls back to keyword-based matching.

#### Usage

```bash
forgepilot --voice
# or
export FORGEPILOT_VOICE="true"
forgepilot
```

Push-to-talk controls:

| Key | Action |
|-----|--------|
| Press **Space** | Start recording — speak your command |
| Press **Space** again | Stop recording — ForgePilot transcribes, AI parses, and executes |
| **q** or **Ctrl+C** | Exit voice mode |

#### What You Can Say

Voice mode uses AI to understand natural language. You don't need to memorize exact phrases — just speak naturally. Here are examples:

**Ticket Management**

| Say something like... | What it does |
|----------------------|-------------|
| "fetch my tickets" / "show my sprint tickets" | List current sprint tickets (paginated, say "show more" for next page) |
| "show all assigned tickets" | List all assigned tickets |
| "fetch my tickets which are at this station" | Search by any Jira status — AI generates proper JQL |
| "find blocked tickets" / "tickets in QA" | Search by status, priority, or keywords |
| "show ticket CE-1234" / "tell me about the second one" | Get full ticket details (supports ordinal references) |
| "move ticket to in progress" | Transition ticket status |
| "show more" / "next page" | Paginate through ticket list |

**Working on Tickets**

| Say something like... | What it does |
|----------------------|-------------|
| "start working on CE-1234" | Resolve repos, pick agent, launch — fully automated |
| "let's start working on the second one" | Start work using ordinal reference from last ticket list |
| "start working on CE-124 and CE-3791" | Launch agents for multiple tickets in parallel |
| "I want to work on adding dark mode" | Custom task — no Jira ticket needed, optionally creates one |
| "prepare branch for CE-1234" | Create/checkout a feature branch |
| "commit my changes" | Stage all + commit (speaks commit message prompt) |
| "push and create PR" | Push branch and create MR/PR |

**Background Jobs**

| Say something like... | What it does |
|----------------------|-------------|
| "list jobs" / "show running agents" | List all background agent jobs with status |
| "what's the status of CE-1234" / "job status" | Get status of a specific ticket's background job |
| "show logs for CE-1234" / "view job logs" | Tail the last 20 lines of a job's log file |
| "stop CE-1234" / "kill that job" | Stop a running background agent |
| "retry CE-1234" / "rerun that job" | Re-launch a failed or stopped job |

**Status & Review**

| Say something like... | What it does |
|----------------------|-------------|
| "check status" / "git status" | Show branch and uncommitted changes |
| "show progress" / "what is done" | Show todo checklist progress |
| "check review comments" | Fetch unresolved PR/MR review comments |

**General**

| Say something like... | What it does |
|----------------------|-------------|
| "help" / "what can you do" | List all available commands |
| "stop" / "goodbye" | Exit voice mode |

#### How AI Parsing Works

When you speak a command, ForgePilot:

1. **Transcribes** your speech using Whisper (offline, in-process)
2. **Sends the transcript to AI** (copilot/cursor CLI) along with context (last ticket, displayed ticket list, repo path)
3. **AI returns a JSON command** with the handler name and extracted parameters (ticket keys, JQL queries, ordinal references, etc.)
4. **Executes the command** using the AI-parsed result

If the AI CLI is unavailable or times out (30s), ForgePilot falls back to keyword-based matching automatically.

#### Voice Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEPILOT_VOICE_TTS` | TTS command for spoken feedback | `say` (macOS) |
| `FORGEPILOT_VOICE_MODEL` | Whisper model size: `tiny.en`, `small.en`, `medium.en`, `large-v3` | `large-v3` |
| `FORGEPILOT_DEFAULT_AGENT` | Skip agent picker when starting ticket work | *(voice prompt)* |
| `FORGEPILOT_PREFLIGHT_AGENT` | AI CLI used for voice command parsing (`copilot` or `cursor`) | `copilot` |
| `FORGEPILOT_JIRA_PROJECT_KEY` | Jira project key for creating tickets from custom tasks (e.g. `CE`) | *(skips ticket creation)* |

#### Siri Shortcut ("Hey Siri, Start ForgePilot")

You can launch voice mode hands-free using a macOS Siri Shortcut:

1. Open the **Shortcuts** app (Spotlight → "Shortcuts")
2. Click **+** to create a new shortcut and name it **"Start ForgePilot"**
3. Add a **"Run Shell Script"** action with this script:

**For Terminal.app:**

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
osascript -e 'tell application "Terminal"
  activate
  do script "forgepilot --voice"
end tell'
```

**For iTerm2:**

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
osascript -e 'tell application "iTerm2"
  activate
  tell current window
    create tab with default profile
    tell current session
      write text "forgepilot --voice"
    end tell
  end tell
end tell'
```

4. Click **Play** to test — it should open a terminal and start voice mode
5. Now say **"Hey Siri, Start ForgePilot"** to launch hands-free

> **Tip:** The shortcut name is the Siri trigger phrase. Ensure "Listen for Hey Siri" is enabled in **System Settings → Siri & Spotlight**. If `forgepilot` is not found, replace it with the full path from `which forgepilot`.

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
| `ollama-local` | `aider` + `ollama` | Local Ollama model via aider — no cloud API needed |

## What ForgePilot Does

When you select a ticket and launch an agent, ForgePilot:

1. **Resolves repositories** — extracts repo URLs from the Jira ticket description, matches them to local repos under your root directory, or presents a TUI picker
2. **Prepares the repo** — stashes changes, fetches latest, checks out base branch, creates a ticket branch (e.g. `CE-1234`)
3. **Checks for checkpoints** — if a previous run was interrupted, detects the existing todo file and offers resume options (see below)
4. **Runs preflight checks** — AI-powered analysis of the ticket for potential concerns, with Q&A via Slack or terminal
5. **Generates a plan** — AI creates a checklist of implementation tasks that you can approve, modify, restart, or skip
6. **Fetches Figma designs** — if Figma links are found, fetches node structure, rendered images, and design tokens
7. **Injects Axon context** — if an Axon knowledge graph exists in the repo, adds structural reasoning protocol to the prompt
8. **Builds a rich prompt** — structured with role, task, workflow steps, ticket context, constraints, contributing guidelines, design context, and clarifications
9. **Launches the AI agent in background** — spawns a detached process and returns to the TUI immediately
10. **Transitions the ticket** — marks it "In Progress" in Jira
11. **Notifies Slack** — sends status updates on start, completion, or failure

### Custom Task Flow

When you choose "Work from a description" instead of a Jira ticket:

1. **Describe the task** — enter a plain-text description of what you want to build
2. **Select repos** — pick from local repos (or let AI decide)
3. **Choose agent and branch** — auto-detected branch prefix (feat/, fix/, etc.) or custom name
4. **Clarifying questions** — AI analyzes your description and asks 1-3 questions to reduce ambiguity
5. **Plan review** — AI generates a checklist that you can approve, modify, restart, or skip
6. **Agent launch** — the agent runs with the approved plan and your clarifications baked into the prompt

### Checkpoint / Resume

ForgePilot uses a todo-driven workflow where AI agents create a `.forgepilot-todos-<TICKET_KEY>.md` checklist and work through it item by item, committing after each task.

If the agent is interrupted (crash, Ctrl+C, timeout), the todo file and checkpoint metadata are preserved. On the next run for the same ticket, ForgePilot detects the existing progress and offers 4 options:

1. **Resume from checkpoint** — continue from the first unchecked item, skipping completed work
2. **Start fresh** — discard all progress and start over from scratch
3. **Re-analyze ticket** — discard the old todo list, let the agent create a fresh plan
4. **Show current progress** — display completed/pending items, then choose from the above options

Checkpoint metadata (agent used, timestamp, repo path) is stored in `.cache/checkpoint-<TICKET_KEY>.json`. The resume prompt is shown via Slack when the Slack flow is active, or in the terminal otherwise.

### MR/PR Review Comments

When a ticket is re-assigned after code review, ForgePilot automatically detects open MR/PRs for the ticket branch and fetches unresolved review comments via the GitHub or GitLab API.

If unresolved comments are found, ForgePilot offers two options:

1. **Address review comments** — creates a todo list from the review feedback and launches the agent with a review-mode prompt that includes the comments and instructs it to work through them
2. **Ignore** — skip review comments and proceed with the normal checkpoint/fresh flow

The agent receives the full review context (file path, line number, author, comment body) and a pre-populated `.forgepilot-todos-<TICKET_KEY>.md` with one item per review comment. After addressing all comments, the updated code can be pushed to the same branch to update the MR/PR.

This requires `FORGEPILOT_GITHUB_TOKEN` or `FORGEPILOT_GITLAB_TOKEN` to be set (same tokens used for PR/MR creation).

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
| `get_todo_progress` | Read and parse the todo checklist for a ticket (completed/pending items) |
| `get_checkpoint` | Load checkpoint metadata for a ticket (agent, timestamps, repo path) |
| `clear_checkpoint` | Discard checkpoint and optionally the todo file for a ticket |
| `get_review_comments` | Find open PR/MR and fetch unresolved review comments for a ticket |
| `launch_background_agent` | Launch an AI agent in the background for a ticket (resolves repos, prepares branch, builds prompt) |
| `list_jobs` | List all background agent jobs with status |
| `get_job_status` | Get detailed status for a specific ticket's job |
| `stop_job` | Stop a running background agent |
| `get_job_logs` | Retrieve the last N lines of a job's log file |
| `start_voice_mode` | Start AI-powered voice mode with natural language understanding (requires `sherpa-onnx-node`, `sox`, and `copilot`/`cursor` CLI) |

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
