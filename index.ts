#!/usr/bin/env node

import readline from 'node:readline';
import chalk from 'chalk';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { getAvailableAgentOptions, launchAgentForCustomTask, resolveAgentOptionById } from './src/core/agents.js';
import { askUser, askUserChoice } from './src/core/ask.js';
import { activateAxonVenv } from './src/tools/axon/axon.js';
import { getCached, setCached } from './src/core/cache.js';
import { runAutoMode, startInteractiveCli } from './src/core/cli.js';
import { createJiraIssue, fetchBoards, fetchTicketsByScope } from './src/tools/jira/jira.js';
import type { TicketScope } from './src/tools/jira/jira.js';
import { pickReposInteractive, scanLocalRepos } from './src/core/repo.js';
import { slackPickScope, startSlackCli } from './src/tools/slack/slack-cli.js';
import { isSlackFullFlowEnabled } from './src/tools/slack/slack.js';
import { renderScopePicker } from './src/core/ui.js';
import type { ScopeOption } from './src/core/ui.js';
import { startVoiceMode } from './src/tools/voice/voice.js';

const SCOPE_OPTIONS: ScopeOption[] = [
	{
		id: 'current-sprint',
		label: 'Current Sprint',
		description: 'Only tickets in the active sprint assigned to you.',
	},
	{
		id: 'all-assigned',
		label: 'All Assigned Tickets',
		description: 'All unresolved tickets assigned to you across all sprints.',
	},
];

function isVoiceMode(): boolean {
	return process.argv.includes('--voice') || process.argv.includes('-v');
}

function isAutoMode(): boolean {
	return (process.env.FORGEPILOT_AUTO_ALL_TICKETS ?? '').trim().toLowerCase() === 'true';
}

function getDefaultAgentId(): string | undefined {
	return process.env.FORGEPILOT_DEFAULT_AGENT?.trim() || undefined;
}

function getEnvScope(): TicketScope | undefined {
	const raw = process.env.FORGEPILOT_TICKET_SCOPE?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === 'current' || raw === 'current-sprint') return 'current-sprint';
	if (raw === 'all' || raw === 'all-assigned') return 'all-assigned';
	return undefined;
}

function pickSingleOption(
	options: ScopeOption[],
	defaultIndex = 0,
	title?: string,
	subtitle?: string,
): Promise<string> {
	return new Promise((resolve) => {
		let selectedIndex = defaultIndex >= 0 ? defaultIndex : 0;

		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);

		const render = () => renderScopePicker(options, selectedIndex, title, subtitle);
		render();

		const onKeypress = (_: unknown, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				process.exit(0);
			}

			if (key.name === 'up') {
				selectedIndex = selectedIndex === 0 ? options.length - 1 : selectedIndex - 1;
				render();
				return;
			}

			if (key.name === 'down') {
				selectedIndex = selectedIndex === options.length - 1 ? 0 : selectedIndex + 1;
				render();
				return;
			}

			if (key.name === 'return' || key.name === 'enter') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				resolve(options[selectedIndex].id);
			}
		};

		process.stdin.on('keypress', onKeypress);
	});
}

function pickScope(cachedScope: TicketScope | null): Promise<TicketScope> {
	const defaultIndex = cachedScope ? SCOPE_OPTIONS.findIndex((o) => o.id === cachedScope) : 0;
	return pickSingleOption(SCOPE_OPTIONS, defaultIndex) as Promise<TicketScope>;
}

function printActiveConfig() {
	const vars: [string, string | undefined][] = [
		['FORGEPILOT_JIRA_BASE_URL', process.env.FORGEPILOT_JIRA_BASE_URL],
		['FORGEPILOT_JIRA_EMAIL', process.env.FORGEPILOT_JIRA_EMAIL],
		['FORGEPILOT_JIRA_API_TOKEN', process.env.FORGEPILOT_JIRA_API_TOKEN ? '***' : undefined],
		['FORGEPILOT_TICKET_SCOPE', process.env.FORGEPILOT_TICKET_SCOPE],
		['FORGEPILOT_DEFAULT_AGENT', process.env.FORGEPILOT_DEFAULT_AGENT],
		['FORGEPILOT_AUTO_ALL_TICKETS', process.env.FORGEPILOT_AUTO_ALL_TICKETS],
		['FORGEPILOT_SKIP_DETAIL', process.env.FORGEPILOT_SKIP_DETAIL],
		['FORGEPILOT_AUTO_PUSH', process.env.FORGEPILOT_AUTO_PUSH],
		['FORGEPILOT_BASE_BRANCH', process.env.FORGEPILOT_BASE_BRANCH],
		['FORGEPILOT_AXON_VENV_PATH', process.env.FORGEPILOT_AXON_VENV_PATH],
		['FORGEPILOT_FIGMA_PAT', process.env.FORGEPILOT_FIGMA_PAT ? '***' : undefined],
		['FORGEPILOT_JIRA_FIGMA_FIELD', process.env.FORGEPILOT_JIRA_FIGMA_FIELD],
		['FORGEPILOT_JIRA_AC_FIELD', process.env.FORGEPILOT_JIRA_AC_FIELD],
		['FORGEPILOT_WORKTREE_DIR', process.env.FORGEPILOT_WORKTREE_DIR],
	];

	const active = vars.filter(([, v]) => v?.trim());
	if (!active.length) return;

	console.log(chalk.gray('\nActive configuration:'));
	for (const [name, value] of active) {
		console.log(chalk.gray(`  ${name}=${value}`));
	}
	console.log();
}

async function runCustomTaskFlow(): Promise<void> {
	const description = await askUser(chalk.cyan('Describe the task you want to work on: '));
	if (!description.trim()) {
		console.log(chalk.yellow('No description provided. Exiting.'));
		return;
	}

	let rootDir = await getCached<string>('rootDir') ?? process.env.FORGEPILOT_ROOT_DIR?.trim();
	if (!rootDir) {
		const input = await askUser(chalk.cyan('Root directory containing your repos (e.g. ~/dev): '));
		if (!input) {
			console.log(chalk.yellow('Root directory is required.'));
			return;
		}
		rootDir = path.resolve(input.replace(/^~/, process.env.HOME ?? '~'));
		if (!existsSync(rootDir)) {
			console.log(chalk.red(`Directory does not exist: ${rootDir}`));
			return;
		}
		await setCached('rootDir', rootDir);
	}
	const resolvedRoot = rootDir.replace(/^~/, process.env.HOME ?? '~');

	console.log(chalk.gray(`Scanning repos in ${resolvedRoot}...`));
	const localRepos = await scanLocalRepos(resolvedRoot);
	if (!localRepos.length) {
		console.log(chalk.yellow('No repositories found in your root directory.'));
		return;
	}

	const selectedRepos = await pickReposInteractive(
		localRepos,
		'Select repo(s) for custom task',
		{ includeAiOption: true },
	);

	if (!selectedRepos.length) {
		console.log(chalk.yellow('No repos selected. Exiting.'));
		return;
	}

	const defaultAgentId = getDefaultAgentId();
	let agentOption = defaultAgentId ? resolveAgentOptionById(defaultAgentId) : undefined;

	if (!agentOption) {
		const agents = await getAvailableAgentOptions();
		if (!agents.length) {
			console.log(chalk.yellow('No AI agent CLIs found on your system.'));
			return;
		}
		const agentChoices = agents.map((a) => ({ id: a.id, label: a.label }));
		const chosenAgentId = await askUserChoice('Select an AI agent:', agentChoices);
		agentOption = agents.find((a) => a.id === chosenAgentId);
		if (!agentOption) return;
	} else {
		console.log(chalk.gray(`Using default agent: ${agentOption.label}`));
	}

	const slug = description
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 15);
	const lowerDesc = description.toLowerCase();
	const branchPrefix = /\b(fix|bug|patch|hotfix|issue)\b/.test(lowerDesc) ? 'fix'
		: /\b(refactor|clean|restructure|reorgani[sz]e)\b/.test(lowerDesc) ? 'refactor'
		: /\b(chore|update|upgrade|bump|config|ci|cd)\b/.test(lowerDesc) ? 'chore'
		: /\b(docs?|readme|documentation)\b/.test(lowerDesc) ? 'docs'
		: /\b(test|spec|coverage)\b/.test(lowerDesc) ? 'test'
		: /\b(perf|optimi[sz]e|speed|fast)\b/.test(lowerDesc) ? 'perf'
		: 'feat';
	const autoBranch = `${branchPrefix}/${slug}`;
	const BRANCH_OPTIONS: ScopeOption[] = [
		{ id: 'auto', label: `Use: ${autoBranch}`, description: `Auto-detected as "${branchPrefix}" from your description.` },
		{ id: 'custom', label: 'Enter a custom branch name', description: 'Type your own branch name (e.g. feat/my-feature).' },
	];
	const branchChoice = await pickSingleOption(BRANCH_OPTIONS, 0, 'Branch Name', 'Choose a branch name for this task:');
	let branchName: string;
	if (branchChoice === 'custom') {
		const input = await askUser(chalk.cyan('  Enter branch name: '));
		const sanitized = (input || autoBranch).trim().replace(/[^a-z0-9/\-]+/gi, '-').replace(/^[-/]+|[-/]+$/g, '');
		branchName = sanitized || autoBranch;
	} else {
		branchName = autoBranch;
	}

	const projectKey = process.env.FORGEPILOT_JIRA_PROJECT_KEY?.trim();
	if (projectKey) {
		const wantTicket = await askUserChoice('Create a Jira ticket for this task?', [
			{ id: 'yes', label: 'Yes — create a ticket' },
			{ id: 'no', label: 'No — work without a ticket' },
		]);
		if (wantTicket === 'yes') {
			try {
				console.log(chalk.gray('Creating Jira ticket...'));
				const detail = await createJiraIssue(projectKey, description, description);
				console.log(chalk.green(`  ✓ Created ${detail.key}`));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.log(chalk.yellow(`  Could not create ticket: ${msg.slice(0, 80)}. Continuing without one.`));
			}
		}
	}

	const repoMap = new Map(selectedRepos.map((r) => [path.basename(r), r]));

	console.log(chalk.bold(`\nLaunching ${agentOption.label} for custom task...`));
	console.log(chalk.gray(`  Branch: ${branchName}`));
	console.log(chalk.gray(`  Repos: ${selectedRepos.map((r) => path.basename(r)).join(', ')}`));

	await launchAgentForCustomTask(description, branchName, agentOption, repoMap);
	console.log(chalk.green('\nCustom task completed.'));
}

async function main() {
	try {
		activateAxonVenv();

		if (isVoiceMode()) {
			await startVoiceMode();
			return;
		}

		printActiveConfig();

		const auto = isAutoMode();
		const defaultAgentId = getDefaultAgentId();

		if (!auto && !isSlackFullFlowEnabled()) {
			const WORK_MODE_OPTIONS: ScopeOption[] = [
				{ id: 'ticket', label: 'Work from a Jira ticket', description: 'Pick a ticket from your board and let an agent implement it.' },
				{ id: 'custom', label: 'Work from a description', description: 'Describe a task in plain text — no Jira ticket needed.' },
			];
			const workMode = await pickSingleOption(WORK_MODE_OPTIONS, 0, 'ForgePilot', 'How would you like to start?');
			if (workMode === 'custom') {
				await runCustomTaskFlow();
				return;
			}
		}

		const envScope = getEnvScope();
		const cachedScope = await getCached<TicketScope>('ticketScope');
		let scope: TicketScope;

		if (envScope) {
			scope = envScope;
			console.log(chalk.gray(`Using FORGEPILOT_TICKET_SCOPE="${scope}"`));
		} else if (auto && cachedScope) {
			scope = cachedScope;
			console.log(chalk.gray(`Auto mode: using cached scope "${scope}"`));
		} else if (auto) {
			scope = 'current-sprint';
			console.log(chalk.gray('Auto mode: defaulting to current-sprint scope'));
		} else if (isSlackFullFlowEnabled()) {
			console.log(chalk.bold('Slack flow enabled. Starting Slack-driven workflow...'));
			scope = await slackPickScope();
		} else {
			scope = await pickScope(cachedScope);
		}
		await setCached('ticketScope', scope);

		const scopeLabel = SCOPE_OPTIONS.find((o) => o.id === scope)?.label ?? scope;
		console.log(chalk.bold(`\nFetching ${scopeLabel.toLowerCase()}...`));
		console.log(chalk.gray('Using Jira REST API'));

		const [boards, tickets] = await Promise.all([fetchBoards(), fetchTicketsByScope(scope)]);

		if (auto && defaultAgentId) {
			const agentOption = resolveAgentOptionById(defaultAgentId);
			if (!agentOption) {
				console.error(chalk.red(`Unknown agent ID: ${defaultAgentId}`));
				console.error(chalk.gray('Valid IDs: copilot-autonomous, claude-code-autonomous, cursor-autonomous, etc.'));
				process.exit(1);
			}

			if (!tickets.length) {
				console.log(chalk.yellow('No tickets found. Nothing to do.'));
				process.exit(0);
			}

			const statuses = await runAutoMode(tickets, agentOption);
			const failed = statuses.filter((s) => s.status === 'failed').length;
			process.exit(failed > 0 ? 1 : 0);
		}

		if (isSlackFullFlowEnabled()) {
			await startSlackCli(tickets, boards);
		} else {
			await startInteractiveCli(tickets, boards);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: ${message}`);
		console.error('\nMake sure FORGEPILOT_JIRA_BASE_URL, FORGEPILOT_JIRA_EMAIL, and FORGEPILOT_JIRA_API_TOKEN are set.');
		process.exit(1);
	}
}

main();
