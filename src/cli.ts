import readline from 'node:readline';
import chalk from 'chalk';
import { getWorkAgentOptions, launchAgentForRepos } from './agents.js';
import { fetchIssueDetail, fetchTicketsByJql, LOAD_MORE_TICKETS_JQL } from './jira.js';
import { resolveRepoPathsFromUser } from './repo.js';
import type { TicketView, WorkAgentOption } from './types.js';
import { clearScreen, renderAgentPicker, renderDetails, renderList, renderPostAgentPrompt } from './ui.js';

export async function startInteractiveCli(tickets: TicketView[], boards: Map<number, string>) {
	let selectedIndex = 0;
	let inDetailView = false;
	let inAgentPicker = false;
	let showPostAgentPrompt = false;
	let postAgentMessage = '';
	let lastAgentOption: WorkAgentOption | null = null;
	let lastResolvedPaths: Map<string, string> | null = null;
	let selectedAgentIndex = 0;
	let loadingDetail = false;
	let loadingMore = false;
	let launchingAgent = false;
	let expandedScope = false;

	readline.emitKeypressEvents(process.stdin);
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
	}

	const cleanup = () => {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
		process.stdin.removeAllListeners('keypress');
	};

	renderList(tickets, selectedIndex, expandedScope);

	process.stdin.on('keypress', async (_, key) => {
		if (key.ctrl && key.name === 'c') {
			cleanup();
			process.exit(0);
		}

		if (inDetailView) {
			if (showPostAgentPrompt) {
				if (key.name === 'r' && lastAgentOption && lastResolvedPaths && !launchingAgent) {
					const selectedTicket = tickets[selectedIndex];
					const selectedDetail = selectedTicket.detail;
					if (!selectedDetail) {
						showPostAgentPrompt = false;
						renderDetails(selectedTicket, boards);
						return;
					}

					launchingAgent = true;
					showPostAgentPrompt = false;
					if (process.stdin.isTTY) process.stdin.setRawMode(false);

					clearScreen();
					console.log(chalk.bold(`Retrying ${lastAgentOption.label} for ${selectedTicket.key}...`));
					let launchFailed = false;
					let launchErrorMessage = '';

					try {
						await launchAgentForRepos(selectedDetail, lastAgentOption, lastResolvedPaths);
					} catch (error) {
						launchFailed = true;
						launchErrorMessage = error instanceof Error ? error.message : String(error);
					} finally {
						if (process.stdin.isTTY) process.stdin.setRawMode(true);
						launchingAgent = false;
					}

					showPostAgentPrompt = true;
					postAgentMessage = launchFailed
						? chalk.red(`Failed to start ${lastAgentOption.label}: ${launchErrorMessage}`)
						: chalk.green(`${lastAgentOption.label} finished. Review output and choose next step.`);
					renderPostAgentPrompt(selectedTicket, postAgentMessage);
					return;
				}
				if (key.name === 'b') {
					showPostAgentPrompt = false;
					inDetailView = false;
					renderList(tickets, selectedIndex, expandedScope);
					return;
				}
				if (
					key.name === 'd' ||
					key.name === 'q' ||
					key.name === 'escape' ||
					key.name === 'backspace' ||
					key.name === 'return'
				) {
					showPostAgentPrompt = false;
					renderDetails(tickets[selectedIndex], boards);
					return;
				}
				return;
			}

			if (inAgentPicker) {
				if (key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
					inAgentPicker = false;
					renderDetails(tickets[selectedIndex], boards);
					return;
				}

				const options = getWorkAgentOptions();

				if (key.name === 'up') {
					selectedAgentIndex = selectedAgentIndex === 0 ? options.length - 1 : selectedAgentIndex - 1;
					renderAgentPicker(tickets[selectedIndex], options, selectedAgentIndex);
					return;
				}

				if (key.name === 'down') {
					selectedAgentIndex = selectedAgentIndex === options.length - 1 ? 0 : selectedAgentIndex + 1;
					renderAgentPicker(tickets[selectedIndex], options, selectedAgentIndex);
					return;
				}

				if ((key.name === 'return' || key.name === 'enter') && !launchingAgent) {
					const selectedTicket = tickets[selectedIndex];
					const selectedDetail = selectedTicket.detail;
					if (!selectedDetail) {
						inAgentPicker = false;
						renderDetails(selectedTicket, boards);
						return;
					}

					launchingAgent = true;
					inAgentPicker = false;
					if (process.stdin.isTTY) process.stdin.setRawMode(false);

					const selectedOption = options[selectedAgentIndex];
					lastAgentOption = selectedOption;
					clearScreen();
					console.log(chalk.bold(`Starting ${selectedOption.label} for ${selectedTicket.key}...`));
					let launchFailed = false;
					let launchErrorMessage = '';

					try {
						const repoPaths = await resolveRepoPathsFromUser(selectedDetail);
						lastResolvedPaths = repoPaths;
						await launchAgentForRepos(selectedDetail, selectedOption, repoPaths);
					} catch (error) {
						launchFailed = true;
						launchErrorMessage = error instanceof Error ? error.message : String(error);
					} finally {
						if (process.stdin.isTTY) process.stdin.setRawMode(true);
						launchingAgent = false;
					}

					showPostAgentPrompt = true;
					postAgentMessage = launchFailed
						? chalk.red(`Failed to start ${selectedOption.label}: ${launchErrorMessage}`)
						: chalk.green(
								`${selectedOption.label} finished. Review output and choose next step.`,
							);
					renderPostAgentPrompt(selectedTicket, postAgentMessage);
					return;
				}
				return;
			}

			if (key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
				inDetailView = false;
				renderList(tickets, selectedIndex, expandedScope);
				return;
			}
			if (key.name === 'w') {
				const selected = tickets[selectedIndex];
				if (!selected.detail || launchingAgent) return;
				inAgentPicker = true;
				selectedAgentIndex = 0;
				renderAgentPicker(selected, getWorkAgentOptions(), selectedAgentIndex);
			}
			return;
		}

		if (key.name === 'q') {
			cleanup();
			process.exit(0);
		}

		if (key.name === 'm') {
			if (loadingMore) return;
			loadingMore = true;
			clearScreen();
			console.log(chalk.bold('Loading more tickets across all boards...'));
			console.log(chalk.gray('Fetching all assigned tickets (including done), excluding subtasks.'));
			try {
				const moreTickets = await fetchTicketsByJql(LOAD_MORE_TICKETS_JQL);
				const byKey = new Map<string, TicketView>();
				for (const t of tickets) byKey.set(t.key, t);
				for (const t of moreTickets) {
					if (!byKey.has(t.key)) byKey.set(t.key, t);
				}
				tickets.splice(0, tickets.length, ...byKey.values());
				expandedScope = true;
				selectedIndex = Math.min(selectedIndex, Math.max(0, tickets.length - 1));
			} catch (error) {
				console.log(
					chalk.red(`Failed to load more tickets: ${error instanceof Error ? error.message : String(error)}`),
				);
			} finally {
				loadingMore = false;
			}
			clearScreen();
			if (expandedScope) {
				console.log(chalk.bold('My Jira Tickets'));
				console.log(chalk.gray('Scope expanded: all assigned tickets (across boards, no subtasks)'));
				console.log(chalk.gray('Press any key to continue...'));
			}
			renderList(tickets, selectedIndex, expandedScope);
			return;
		}

		if (!tickets.length || loadingDetail || loadingMore || launchingAgent) return;

		if (key.name === 'up') {
			selectedIndex = selectedIndex === 0 ? tickets.length - 1 : selectedIndex - 1;
			renderList(tickets, selectedIndex, expandedScope);
			return;
		}

		if (key.name === 'down') {
			selectedIndex = selectedIndex === tickets.length - 1 ? 0 : selectedIndex + 1;
			renderList(tickets, selectedIndex, expandedScope);
			return;
		}

		if (key.name === 'return' || key.name === 'enter') {
			const selected = tickets[selectedIndex];
			loadingDetail = true;
			clearScreen();
			console.log(`Loading ${selected.key} details via acli...`);
			try {
				selected.detail = await fetchIssueDetail(selected.key);
			} catch (error) {
				selected.detail = {
					key: selected.key,
					fields: {
						summary: selected.title,
						status: { name: selected.status },
						description: `Failed to load details: ${error instanceof Error ? error.message : String(error)}`,
						comment: { comments: [] },
						issuelinks: [],
					},
				};
			} finally {
				loadingDetail = false;
			}
			inDetailView = true;
			renderDetails(selected, boards);
		}
	});
}
