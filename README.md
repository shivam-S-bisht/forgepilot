# ForgePilot CLI

A local CLI to run coding agents against any repository while automatically injecting repo guidelines (such as `CONTRIBUTING.md`, `AGENTS.md`, and `.cursor/rules/*`).

## Install (local)

```bash
cd ~/dev/forgepilot
npm link
```

After this, `forgepilot` is available globally on your machine.

## Usage

```bash
forgepilot [--target-dir <path>] [--jira "<jira-description>"] [--task "<task>"] [--agent <agent-id>]
```

## Agent IDs

- `copilot-auto`
- `copilot-interactive`
- `rovo-auto`
- `cursor-auto`

If `--agent` is not provided, an arrow-key selector opens.

## Examples

```bash
# run with prompts for missing inputs
forgepilot --task "Implement unread notification endpoint"

# pass target parent directory and Jira description directly
forgepilot --target-dir ~/dev --jira "Admin repo - https://github.com/acme/admin" --task "Fix failing auth tests"

# choose agent directly
forgepilot --dir ~/dev --jira "Admin - git@github.com:acme/admin.git, RN - https://github.com/acme/mobile" --task "Refactor challenge API" --agent copilot-auto
```

## How prompt context is built

For each resolved repo from Jira URLs, the CLI scans for:

- `CONTRIBUTING.md`
- `AGENTS.md`
- `RULES.md`
- `.cursor/rules/**/*.{md,mdc,txt}`

It appends those contents to the task prompt and launches the selected agent from each target repo directory.
