#!/usr/bin/env node

import readline from 'node:readline';
import chalk from 'chalk';
import { resolveAgentOptionById } from './src/agents.js';
import { activateAxonVenv } from './src/axon.js';
import { getCached, setCached } from './src/cache.js';
import { runAutoMode, startInteractiveCli } from './src/cli.js';
import { fetchBoards, fetchTicketsByScope } from './src/jira.js';
import type { TicketScope } from './src/jira.js';
import { renderScopePicker } from './src/ui.js';
import type { ScopeOption } from './src/ui.js';

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

function isAutoMode(): boolean {
	return (process.env.FORGEPILOT_AUTO_ALL_TICKETS ?? '').trim().toLowerCase() === 'true';
}

function getDefaultAgentId(): string | undefined {
	return process.env.FORGEPILOT_DEFAULT_AGENT?.trim() || undefined;
}

function pickScope(cachedScope: TicketScope | null): Promise<TicketScope> {
	return new Promise((resolve) => {
		const defaultIndex = cachedScope ? SCOPE_OPTIONS.findIndex((o) => o.id === cachedScope) : 0;
		let selectedIndex = defaultIndex >= 0 ? defaultIndex : 0;

		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);

		renderScopePicker(SCOPE_OPTIONS, selectedIndex);

		const onKeypress = (_: unknown, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				process.exit(0);
			}

			if (key.name === 'up') {
				selectedIndex = selectedIndex === 0 ? SCOPE_OPTIONS.length - 1 : selectedIndex - 1;
				renderScopePicker(SCOPE_OPTIONS, selectedIndex);
				return;
			}

			if (key.name === 'down') {
				selectedIndex = selectedIndex === SCOPE_OPTIONS.length - 1 ? 0 : selectedIndex + 1;
				renderScopePicker(SCOPE_OPTIONS, selectedIndex);
				return;
			}

			if (key.name === 'return' || key.name === 'enter') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				resolve(SCOPE_OPTIONS[selectedIndex].id as TicketScope);
			}
		};

		process.stdin.on('keypress', onKeypress);
	});
}

async function main() {
	try {
		activateAxonVenv();

		const auto = isAutoMode();
		const defaultAgentId = getDefaultAgentId();

		const cachedScope = await getCached<TicketScope>('ticketScope');
		let scope: TicketScope;

		if (auto && cachedScope) {
			scope = cachedScope;
			console.log(chalk.gray(`Auto mode: using cached scope "${scope}"`));
		} else if (auto) {
			scope = 'current-sprint';
			console.log(chalk.gray('Auto mode: defaulting to current-sprint scope'));
		} else {
			scope = await pickScope(cachedScope);
		}
		await setCached('ticketScope', scope);

		const scopeLabel = SCOPE_OPTIONS.find((o) => o.id === scope)?.label ?? scope;
		console.log(chalk.bold(`\nFetching ${scopeLabel.toLowerCase()}...`));
		console.log(chalk.gray('Using authenticated acli session'));

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

		await startInteractiveCli(tickets, boards);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: ${message}`);
		console.error('\nMake sure `acli auth login` is completed and Jira access is available.');
		process.exit(1);
	}
}

main();
