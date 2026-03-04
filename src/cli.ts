import readline from 'node:readline';
import chalk from 'chalk';
import {
	cleanupWorktrees,
	getAvailableAgentOptions,
	launchAgentForRepos,
	launchMultipleTickets,
	resolveAgentOptionById,
} from './agents.js';
import { pushBranchAndCreateMR } from './git.js';
import { fetchIssueDetail, fetchTicketsByJql, LOAD_MORE_TICKETS_JQL } from './jira.js';
import { getJiraBrowseUrl } from './jira-text.js';
import { resolveRepoPathsFromUser } from './repo.js';
import type { TicketRunStatus, TicketView, WorkAgentOption } from './types.js';
import {
	clearScreen,
	renderAgentPicker,
	renderDetails,
	renderList,
	renderMultiAgentPicker,
	renderMultiTicketDashboard,
	renderMultiTicketSummary,
	renderPostAgentPrompt,
} from './ui.js';

const INTERACTIVE_AGENT_IDS = new Set(['copilot-interactive', 'claude-code-interactive']);

function filterAutonomousAgents(options: WorkAgentOption[]): WorkAgentOption[] {
	return options.filter((o) => !INTERACTIVE_AGENT_IDS.has(o.id));
}

export async function startInteractiveCli(tickets: TicketView[], boards: Map<number, string>) {
	let selectedIndex = 0;
	let inDetailView = false;
	let inAgentPicker = false;
	let inMultiAgentPicker = false;
	let showPostAgentPrompt = false;
	let showMultiSummary = false;
	let postAgentMessage = '';
	let lastAgentOption: WorkAgentOption | null = null;
	let lastResolvedPaths: Map<string, string> | null = null;
	let lastMultiStatuses: TicketRunStatus[] = [];
	let selectedAgentIndex = 0;
	let agentOptions: WorkAgentOption[] = [];
	let loadingDetail = false;
	let loadingMore = false;
	let launchingAgent = false;
	let expandedScope = false;
	const checkedIndices = new Set<number>();

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

	const redrawList = () => renderList(tickets, selectedIndex, expandedScope, checkedIndices);

	redrawList();

	process.stdin.on('keypress', async (_, key) => {
		if (key.ctrl && key.name === 'c') {
			cleanup();
			process.exit(0);
		}

		if (showMultiSummary) {
			if (key.name === 'p' && !launchingAgent) {
				launchingAgent = true;
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				clearScreen();
				console.log(chalk.bold('Pushing branches & creating MR/PRs...'));

				const successStatuses = lastMultiStatuses.filter((s) => s.status === 'done');
				for (const s of successStatuses) {
					for (const repoPath of s.repos) {
						try {
							const url = await pushBranchAndCreateMR(repoPath, s.ticketKey, s.title, '');
							if (url) console.log(chalk.green(`  ${s.ticketKey}: ${url}`));
						} catch (error) {
							console.log(chalk.red(`  ${s.ticketKey}: ${error instanceof Error ? error.message : String(error)}`));
						}
					}
				}

				if (process.stdin.isTTY) process.stdin.setRawMode(true);
				launchingAgent = false;
				renderMultiTicketSummary(lastMultiStatuses);
				return;
			}
			if (key.name === 'c' && !launchingAgent) {
				launchingAgent = true;
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				clearScreen();
				console.log(chalk.bold('Cleaning up worktrees...'));
				await cleanupWorktrees(lastMultiStatuses);
				console.log(chalk.green('Done.'));
				if (process.stdin.isTTY) process.stdin.setRawMode(true);
				launchingAgent = false;
				renderMultiTicketSummary(lastMultiStatuses);
				return;
			}
			if (key.name === 'b') {
				showMultiSummary = false;
				lastMultiStatuses = [];
				checkedIndices.clear();
				redrawList();
				return;
			}
			return;
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
				if (key.name === 'p' && lastResolvedPaths && !launchingAgent) {
					const selectedTicket = tickets[selectedIndex];
					const selectedDetail = selectedTicket.detail;
					if (!selectedDetail) return;

					launchingAgent = true;
					if (process.stdin.isTTY) process.stdin.setRawMode(false);
					clearScreen();
					console.log(chalk.bold(`Pushing branch & creating MR/PR for ${selectedTicket.key}...`));

					const jiraUrl = getJiraBrowseUrl(selectedDetail);
					const title = String(selectedDetail.fields.summary ?? selectedTicket.title);
					const mrUrls: string[] = [];

					try {
						for (const repoPath of lastResolvedPaths.values()) {
							const url = await pushBranchAndCreateMR(repoPath, selectedTicket.key, title, jiraUrl);
							if (url) mrUrls.push(url);
						}
						postAgentMessage = mrUrls.length
							? chalk.green(`MR/PR created:\n${mrUrls.map((u) => `  ${u}`).join('\n')}`)
							: chalk.yellow('Branch pushed but no MR/PR URL returned.');
					} catch (error) {
						postAgentMessage = chalk.red(`Push/MR failed: ${error instanceof Error ? error.message : String(error)}`);
					} finally {
						if (process.stdin.isTTY) process.stdin.setRawMode(true);
						launchingAgent = false;
					}

					renderPostAgentPrompt(selectedTicket, postAgentMessage);
					return;
				}
				if (key.name === 'b') {
					showPostAgentPrompt = false;
					inDetailView = false;
					redrawList();
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

				if (key.name === 'up') {
					selectedAgentIndex = selectedAgentIndex === 0 ? agentOptions.length - 1 : selectedAgentIndex - 1;
					renderAgentPicker(tickets[selectedIndex], agentOptions, selectedAgentIndex);
					return;
				}

				if (key.name === 'down') {
					selectedAgentIndex = selectedAgentIndex === agentOptions.length - 1 ? 0 : selectedAgentIndex + 1;
					renderAgentPicker(tickets[selectedIndex], agentOptions, selectedAgentIndex);
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

					const selectedOption = agentOptions[selectedAgentIndex];
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
				redrawList();
				return;
			}
			if (key.name === 'w') {
				const selected = tickets[selectedIndex];
				if (!selected.detail || launchingAgent) return;

				const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
				if (defaultAgentId) {
					const defaultOption = resolveAgentOptionById(defaultAgentId);
					if (defaultOption) {
						launchingAgent = true;
						if (process.stdin.isTTY) process.stdin.setRawMode(false);

						lastAgentOption = defaultOption;
						clearScreen();
						console.log(chalk.bold(`Starting ${defaultOption.label} for ${selected.key}...`));
						let launchFailed = false;
						let launchErrorMessage = '';

						try {
							const repoPaths = await resolveRepoPathsFromUser(selected.detail);
							lastResolvedPaths = repoPaths;
							await launchAgentForRepos(selected.detail, defaultOption, repoPaths);
						} catch (error) {
							launchFailed = true;
							launchErrorMessage = error instanceof Error ? error.message : String(error);
						} finally {
							if (process.stdin.isTTY) process.stdin.setRawMode(true);
							launchingAgent = false;
						}

						showPostAgentPrompt = true;
						postAgentMessage = launchFailed
							? chalk.red(`Failed to start ${defaultOption.label}: ${launchErrorMessage}`)
							: chalk.green(`${defaultOption.label} finished. Review output and choose next step.`);
						renderPostAgentPrompt(selected, postAgentMessage);
						return;
					}
				}

				clearScreen();
				console.log(chalk.gray('Detecting available AI agents...'));
				agentOptions = await getAvailableAgentOptions();
				if (!agentOptions.length) {
					clearScreen();
					console.log(chalk.yellow('No AI agent CLIs found in PATH.'));
					console.log(chalk.gray('Install one of: copilot, cursor, acli (for Rovo)'));
					console.log(chalk.gray('\nPress any key to go back...'));
					return;
				}
				inAgentPicker = true;
				selectedAgentIndex = 0;
				renderAgentPicker(selected, agentOptions, selectedAgentIndex);
			}
			return;
		}

		if (inMultiAgentPicker) {
			if (key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
				inMultiAgentPicker = false;
				redrawList();
				return;
			}

			if (key.name === 'up') {
				selectedAgentIndex = selectedAgentIndex === 0 ? agentOptions.length - 1 : selectedAgentIndex - 1;
				const selectedTickets = [...checkedIndices].map((i) => tickets[i]);
				renderMultiAgentPicker(selectedTickets, agentOptions, selectedAgentIndex);
				return;
			}

			if (key.name === 'down') {
				selectedAgentIndex = selectedAgentIndex === agentOptions.length - 1 ? 0 : selectedAgentIndex + 1;
				const selectedTickets = [...checkedIndices].map((i) => tickets[i]);
				renderMultiAgentPicker(selectedTickets, agentOptions, selectedAgentIndex);
				return;
			}

			if ((key.name === 'return' || key.name === 'enter') && !launchingAgent) {
				const selectedTickets = [...checkedIndices].map((i) => tickets[i]);
				const selectedOption = agentOptions[selectedAgentIndex];

				inMultiAgentPicker = false;
				launchingAgent = true;
				if (process.stdin.isTTY) process.stdin.setRawMode(false);

				clearScreen();
				console.log(chalk.bold(`Loading details for ${selectedTickets.length} ticket(s)...`));

				const details = await Promise.all(
					selectedTickets.map(async (t) => {
						if (t.detail) return t.detail;
						try {
							t.detail = await fetchIssueDetail(t.key);
							return t.detail;
						} catch {
							return null;
						}
					}),
				);

				const validDetails = details.filter((d) => d !== null);
				if (!validDetails.length) {
					clearScreen();
					console.log(chalk.red('Could not load details for any selected ticket.'));
					if (process.stdin.isTTY) process.stdin.setRawMode(true);
					launchingAgent = false;
					redrawList();
					return;
				}

				lastMultiStatuses = await launchMultipleTickets(
					validDetails,
					selectedOption,
					(statuses) => renderMultiTicketDashboard(statuses),
				);

				if (process.stdin.isTTY) process.stdin.setRawMode(true);
				launchingAgent = false;
				showMultiSummary = true;
				renderMultiTicketSummary(lastMultiStatuses);
				return;
			}
			return;
		}

		if (key.name === 'q') {
			cleanup();
			process.exit(0);
		}

		if (key.name === 'space' && !loadingDetail && !loadingMore && !launchingAgent && tickets.length) {
			if (checkedIndices.has(selectedIndex)) checkedIndices.delete(selectedIndex);
			else checkedIndices.add(selectedIndex);
			redrawList();
			return;
		}

		if (key.name === 'a' && !loadingDetail && !loadingMore && !launchingAgent && tickets.length) {
			if (checkedIndices.size === tickets.length) {
				checkedIndices.clear();
			} else {
				for (let i = 0; i < tickets.length; i++) checkedIndices.add(i);
			}
			redrawList();
			return;
		}

		if (key.name === 'w' && checkedIndices.size > 1 && !launchingAgent) {
			const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
			if (defaultAgentId) {
				const defaultOption = resolveAgentOptionById(defaultAgentId);
				if (defaultOption && !INTERACTIVE_AGENT_IDS.has(defaultOption.id)) {
					const selectedTickets = [...checkedIndices].map((i) => tickets[i]);
					launchingAgent = true;
					if (process.stdin.isTTY) process.stdin.setRawMode(false);

					clearScreen();
					console.log(chalk.bold(`Loading details for ${selectedTickets.length} ticket(s)...`));

					const details = await Promise.all(
						selectedTickets.map(async (t) => {
							if (t.detail) return t.detail;
							try {
								t.detail = await fetchIssueDetail(t.key);
								return t.detail;
							} catch {
								return null;
							}
						}),
					);

					const validDetails = details.filter((d) => d !== null);
					if (!validDetails.length) {
						clearScreen();
						console.log(chalk.red('Could not load details for any selected ticket.'));
						if (process.stdin.isTTY) process.stdin.setRawMode(true);
						launchingAgent = false;
						redrawList();
						return;
					}

					lastMultiStatuses = await launchMultipleTickets(
						validDetails,
						defaultOption,
						(statuses) => renderMultiTicketDashboard(statuses),
					);

					if (process.stdin.isTTY) process.stdin.setRawMode(true);
					launchingAgent = false;
					showMultiSummary = true;
					renderMultiTicketSummary(lastMultiStatuses);
					return;
				}
			}

			clearScreen();
			console.log(chalk.gray('Detecting available AI agents...'));
			const allOptions = await getAvailableAgentOptions();
			agentOptions = filterAutonomousAgents(allOptions);
			if (!agentOptions.length) {
				clearScreen();
				console.log(chalk.yellow('No autonomous AI agent CLIs found in PATH.'));
				console.log(chalk.gray('\nPress any key to go back...'));
				return;
			}
			inMultiAgentPicker = true;
			selectedAgentIndex = 0;
			const selectedTickets = [...checkedIndices].map((i) => tickets[i]);
			renderMultiAgentPicker(selectedTickets, agentOptions, selectedAgentIndex);
			return;
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
				checkedIndices.clear();
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
			redrawList();
			return;
		}

		if (!tickets.length || loadingDetail || loadingMore || launchingAgent) return;

		if (key.name === 'up') {
			selectedIndex = selectedIndex === 0 ? tickets.length - 1 : selectedIndex - 1;
			redrawList();
			return;
		}

		if (key.name === 'down') {
			selectedIndex = selectedIndex === tickets.length - 1 ? 0 : selectedIndex + 1;
			redrawList();
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

export async function runAutoMode(
	tickets: TicketView[],
	agentOption: WorkAgentOption,
): Promise<TicketRunStatus[]> {
	console.log(chalk.bold(`Auto mode: processing ${tickets.length} ticket(s) with ${agentOption.label}`));

	console.log(chalk.gray('Loading ticket details...'));
	const details = await Promise.all(
		tickets.map(async (t) => {
			try {
				t.detail = await fetchIssueDetail(t.key);
				return t.detail;
			} catch {
				return null;
			}
		}),
	);

	const validDetails = details.filter((d) => d !== null);
	if (!validDetails.length) {
		console.log(chalk.red('Could not load details for any ticket.'));
		return [];
	}

	console.log(chalk.gray(`Loaded ${validDetails.length} ticket(s). Starting parallel execution...`));

	const statuses = await launchMultipleTickets(
		validDetails,
		agentOption,
		(s) => renderMultiTicketDashboard(s),
	);

	renderMultiTicketSummary(statuses);
	return statuses;
}
