# ForgePilot CLI

A local CLI to run coding agents against any repository while automatically injecting repo guidelines (such as `CONTRIBUTING.md`, `AGENTS.md`, and `.cursor/rules/*`).

## Install (local)

```bash
cd ~/dev/forgepilot
npm run build
npm link
```

After this, `forgepilot` is available globally on your machine.

For TypeScript changes, build once before running locally:

```bash
npm run build
```

## Publish (private via GitHub Packages)

This package is scoped to `@shivam-s-bisht`.

1) Add auth token on publisher machine in `~/.npmrc`:

```ini
@shivam-s-bisht:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_your_token
```

2) Build and publish:

```bash
npm run build
npm publish
```

## Release flow (SemVer + changelog + tag publish)

This project uses `standard-version` to bump versions using commit history and update `CHANGELOG.md`.

- `fix:` commits bump patch (`x.y.z+1`)
- `feat:` commits bump minor (`x.y+1.0`)
- `BREAKING CHANGE:` bumps major (`x+1.0.0`)

Release steps:

```bash
# create version bump + CHANGELOG.md + git tag (vX.Y.Z)
npm run release

# push commit and tag
git push && git push --tags
```

When a tag like `v1.2.3` is pushed, GitHub Actions workflow publishes automatically to GitHub Packages.

For the first release:

```bash
npm run release:first
git push && git push --tags
```

## Install (private with token)

On user machine, add in `~/.npmrc`:

```ini
@shivam-s-bisht:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_user_read_token
```

Then install globally:

```bash
npm i -g @shivam-s-bisht/forgepilot
forgepilot
```

## Usage

```bash
forgepilot --tickets
forgepilot [--target-dir <path>] [--jira "<jira-description>"] [--task "<task>"] [--agent <agent-id>]
forgepilot --list-tickets
```

## Agent IDs

- `copilot-auto`
- `copilot-interactive`
- `rovo-auto`
- `cursor-auto`

If `--agent` is not provided, an arrow-key selector opens.

## Examples

```bash
# open interactive Jira ticket workflow (admin-like)
forgepilot --tickets --target-dir ~/dev

# list all your assigned Jira ticket links
forgepilot --list-tickets

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
