import { existsSync, watch as fsWatch } from 'node:fs';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import chalk from 'chalk';
import {
	cleanupWorktrees,
	getAvailableAgentOptions,
	launchAgentForRepos,
	launchAgentInBackground,
	launchMultipleTickets,
	launchMultipleTicketsInBackground,
	resolveAgentOptionById,
} from './agents.js';
import { getJobs, cleanupStaleJobs, isTicketRunning } from './job-manager.js';
import type { JobStatus } from './job-manager.js';
import { pushBranchAndCreateMR } from '../tools/git/git.js';
import { fetchIssueDetail, fetchTicketsByJql, LOAD_MORE_TICKETS_JQL } from '../tools/jira/jira.js';
import { getJiraBrowseUrl } from '../tools/jira/jira-text.js';
import { resolveRepoPathsFromUser } from './repo.js';
import type { TicketRunStatus, TicketView, WorkAgentOption } from './types.js';
import {
	clearScreen,
	enterAlternateScreen,
	leaveAlternateScreen,
	renderAgentPicker,
	renderDetails,
	renderList,
	renderMultiAgentPicker,
	renderMultiTicketBrief,
	renderMultiTicketDashboard,
	renderMultiTicketSummary,
	renderPostAgentPrompt,
	renderJobList,
	renderLogViewer,
	renderMultiLogViewer,
} from './ui.js';
import { getJob, stopJob } from './job-manager.js';

const INTERACTIVE_AGENT_IDS = new Set(['copilot-interactive', 'claude-code-interactive']);

function filterAutonomousAgents(options: WorkAgentOption[]): WorkAgentOption[] {
	return options.filter((o) => !INTERACTIVE_AGENT_IDS.has(o.id));
}

export async function startInteractiveCli(tickets: TicketView[], boards: Map<number, string>) {
	let selectedIndex = 0;
	let inDetailView = false;
	let inAgentPicker = false;
	let inMultiAgentPicker = false;
	let inMultiBrief = false;
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
	let isAwaitingInput = false;
	let expandedScope = false;
	let inJobList = false;
	let inLogViewer = false;
	let inMultiLogViewer = false;
	let jobListItems: import('./job-manager.js').JobRecord[] = [];
	let selectedJobIndex = 0;
	const selectedJobIds = new Set<string>();
	let viewingJob: import('./job-manager.js').JobRecord | null = null;
	let viewingJobs: import('./job-manager.js').JobRecord[] = [];
	let selectedMultiLogIndex = 0;
	let logTailInterval: ReturnType<typeof setInterval> | null = null;
	let logFileWatchers: import('node:fs').FSWatcher[] = [];
	let logWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	const checkedIndices = new Set<number>();
	const jobStatusMap = new Map<string, JobStatus>();

	async function refreshJobStatuses(): Promise<void> {
		const jobs = await getJobs();
		jobStatusMap.clear();
		for (const job of jobs) {
			if (job.status === 'running' || job.status === 'done' || job.status === 'failed' || job.status === 'stopped') {
				jobStatusMap.set(job.ticketKey, job.status);
			}
		}
	}

	await cleanupStaleJobs();
	await refreshJobStatuses();

	readline.emitKeypressEvents(process.stdin);
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
	}

	let statusRefreshInterval: ReturnType<typeof setInterval> | null = null;

	// Enter alternate screen so the TUI renders in a separate buffer.
	// When the CLI exits (any path), leaveAlternateScreen() restores the
	// original terminal content — including all prior log scroll-back history.
	enterAlternateScreen();

	const cleanup = () => {
		if (logTailInterval) {
			clearInterval(logTailInterval);
			logTailInterval = null;
		}
		for (const w of logFileWatchers) { try { w.close(); } catch { /* ignore */ } }
		logFileWatchers = [];
		if (logWatchDebounceTimer) { clearTimeout(logWatchDebounceTimer); logWatchDebounceTimer = null; }
		if (statusRefreshInterval) {
			clearInterval(statusRefreshInterval);
			statusRefreshInterval = null;
		}
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
		process.stdin.removeAllListeners('keypress');
		leaveAlternateScreen();
	};

	async function readLogTail(filePath: string, lines = 30): Promise<string[]> {
		if (!existsSync(filePath)) return [];
		try {
			const content = await fs.readFile(filePath, 'utf8');
			return content.split('\n').slice(-lines);
		} catch {
			return [];
		}
	}

	async function openJobList(): Promise<void> {
		jobListItems = await getJobs();
		selectedJobIndex = 0;
		selectedJobIds.clear();
		inJobList = true;
		renderJobList(jobListItems, selectedJobIndex, selectedJobIds);
	}

	async function openLogViewer(job: import('./job-manager.js').JobRecord): Promise<void> {
		viewingJob = job;
		inLogViewer = true;
		inMultiLogViewer = false;
		inJobList = false;
		const lines = await readLogTail(job.logFile);
		renderLogViewer(job, lines);

		// Clear any previous watcher/interval
		if (logTailInterval) { clearInterval(logTailInterval); logTailInterval = null; }
		for (const w of logFileWatchers) { try { w.close(); } catch { /* ignore */ } }
		logFileWatchers = [];
		if (logWatchDebounceTimer) { clearTimeout(logWatchDebounceTimer); logWatchDebounceTimer = null; }

		const scheduleRefresh = async () => {
			if (!inLogViewer || !viewingJob) return;
			const freshJob = await getJob(viewingJob.id);
			if (freshJob) viewingJob = freshJob;
			const freshLines = await readLogTail(viewingJob.logFile);
			renderLogViewer(viewingJob, freshLines);
		};

		const attachWatcher = (filePath: string) => {
			try {
				const w = fsWatch(filePath, () => {
					if (logWatchDebounceTimer) clearTimeout(logWatchDebounceTimer);
					logWatchDebounceTimer = setTimeout(() => { void scheduleRefresh(); }, 80);
				});
				w.on('error', () => { /* watcher error — slow poll covers it */ });
				logFileWatchers.push(w);
			} catch {
				// fs.watch unavailable for this path; slow poll will handle it
			}
		};

		if (existsSync(job.logFile)) {
			attachWatcher(job.logFile);
		}

		// Slow poll: catches job status changes and the "file not yet created" window
		logTailInterval = setInterval(async () => {
			if (!inLogViewer || !viewingJob) return;
			// Attach watcher once file appears
			if (existsSync(viewingJob.logFile) && logFileWatchers.length === 0) {
				attachWatcher(viewingJob.logFile);
			}
			await scheduleRefresh();
		}, 2000);
	}

	async function openMultiLogViewer(jobs: import('./job-manager.js').JobRecord[]): Promise<void> {
		viewingJobs = jobs;
		selectedMultiLogIndex = 0;
		inMultiLogViewer = true;
		inLogViewer = false;
		inJobList = false;

		const tails = await Promise.all(jobs.map(async (job) => ({ job, lines: await readLogTail(job.logFile) })));
		renderMultiLogViewer(tails, selectedMultiLogIndex);

		// Clear any previous watcher/interval
		if (logTailInterval) { clearInterval(logTailInterval); logTailInterval = null; }
		for (const w of logFileWatchers) { try { w.close(); } catch { /* ignore */ } }
		logFileWatchers = [];
		if (logWatchDebounceTimer) { clearTimeout(logWatchDebounceTimer); logWatchDebounceTimer = null; }

		const scheduleMultiRefresh = async () => {
			if (!inMultiLogViewer || viewingJobs.length === 0) return;
			const freshJobs = await Promise.all(viewingJobs.map(async (job) => (await getJob(job.id)) ?? job));
			viewingJobs = freshJobs;
			const freshTails = await Promise.all(viewingJobs.map(async (job) => ({ job, lines: await readLogTail(job.logFile) })));
			renderMultiLogViewer(freshTails, selectedMultiLogIndex);
		};

		for (const job of jobs) {
			if (existsSync(job.logFile)) {
				try {
					const w = fsWatch(job.logFile, () => {
						if (logWatchDebounceTimer) clearTimeout(logWatchDebounceTimer);
						logWatchDebounceTimer = setTimeout(() => { void scheduleMultiRefresh(); }, 80);
					});
					w.on('error', () => { /* watcher error — slow poll covers it */ });
					logFileWatchers.push(w);
				} catch { /* unavailable */ }
			}
		}

		// Slow poll: catches status changes and newly-created log files
		logTailInterval = setInterval(async () => {
			if (!inMultiLogViewer || viewingJobs.length === 0) return;
			// Attach watchers for any log files that just appeared
			const watched = new Set(logFileWatchers.map((_, i) => i));
			for (let i = watched.size; i < viewingJobs.length; i++) {
				const f = viewingJobs[i].logFile;
				if (existsSync(f)) {
					try {
						const w = fsWatch(f, () => {
							if (logWatchDebounceTimer) clearTimeout(logWatchDebounceTimer);
							logWatchDebounceTimer = setTimeout(() => { void scheduleMultiRefresh(); }, 80);
						});
						w.on('error', () => { /* ignore */ });
						logFileWatchers.push(w);
					} catch { /* unavailable */ }
				}
			}
			await scheduleMultiRefresh();
		}, 2000);
	}

	async function openLogsForTicketKeys(ticketKeys: string[]): Promise<void> {
		const jobs = await getJobs();
		const filtered = jobs
			.filter((job) => ticketKeys.includes(job.ticketKey))
			.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

		const latestByTicket = new Map<string, import('./job-manager.js').JobRecord>();
		for (const job of filtered) {
			if (!latestByTicket.has(job.ticketKey)) latestByTicket.set(job.ticketKey, job);
		}

		const selectedJobs = [...latestByTicket.values()];
		if (selectedJobs.length === 0) {
			clearScreen();
			console.log(chalk.yellow('No logs found for selected ticket(s).'));
			console.log(chalk.gray('\nReturning to ticket list...'));
			await new Promise((resolve) => setTimeout(resolve, 1200));
			redrawList();
			return;
		}

		if (selectedJobs.length === 1) {
			await openLogViewer(selectedJobs[0]);
			return;
		}

		await openMultiLogViewer(selectedJobs);
	}

	function closeLogViewer(): void {
		if (logTailInterval) {
			clearInterval(logTailInterval);
			logTailInterval = null;
		}
		for (const w of logFileWatchers) { try { w.close(); } catch { /* ignore */ } }
		logFileWatchers = [];
		if (logWatchDebounceTimer) { clearTimeout(logWatchDebounceTimer); logWatchDebounceTimer = null; }
		viewingJob = null;
		viewingJobs = [];
		inLogViewer = false;
		inMultiLogViewer = false;
	}

	const redrawList = () => renderList(tickets, selectedIndex, expandedScope, checkedIndices, jobStatusMap);

	const isMainListVisible = () =>
		!inDetailView && !inAgentPicker && !inMultiAgentPicker && !inMultiBrief &&
		!showPostAgentPrompt && !showMultiSummary && !inJobList && !inLogViewer && !inMultiLogViewer && !launchingAgent && !isAwaitingInput;

	statusRefreshInterval = setInterval(async () => {
		await cleanupStaleJobs();
		const prevMap = new Map(jobStatusMap);
		await refreshJobStatuses();
		let changed = false;
		for (const [k, v] of jobStatusMap) {
			if (prevMap.get(k) !== v) { changed = true; break; }
		}
		for (const k of prevMap.keys()) {
			if (!jobStatusMap.has(k)) { changed = true; break; }
		}
		if (changed && isMainListVisible()) {
			redrawList();
		}
	}, 5000);

	redrawList();

	process.stdin.on('keypress', async (_, key) => {
		if (key.ctrl && key.name === 'c') {
			cleanup();
			process.exit(0);
		}

		if (isAwaitingInput) return;

		if (inMultiLogViewer) {
			if (key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
				closeLogViewer();
				await openJobList();
				return;
			}
			if (key.name === 'up' && viewingJobs.length) {
				selectedMultiLogIndex = selectedMultiLogIndex === 0 ? viewingJobs.length - 1 : selectedMultiLogIndex - 1;
				const tails = await Promise.all(viewingJobs.map(async (job) => ({ job, lines: await readLogTail(job.logFile) })));
				renderMultiLogViewer(tails, selectedMultiLogIndex);
				return;
			}
			if (key.name === 'down' && viewingJobs.length) {
				selectedMultiLogIndex = selectedMultiLogIndex === viewingJobs.length - 1 ? 0 : selectedMultiLogIndex + 1;
				const tails = await Promise.all(viewingJobs.map(async (job) => ({ job, lines: await readLogTail(job.logFile) })));
				renderMultiLogViewer(tails, selectedMultiLogIndex);
				return;
			}
			return;
		}

		if (inLogViewer) {
			if (key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
				closeLogViewer();
				await openJobList();
				return;
			}
			if (key.name === 's' && viewingJob?.status === 'running') {
				await stopJob(viewingJob.id);
				const freshJob = await getJob(viewingJob.id);
				if (freshJob) viewingJob = freshJob;
				const lines = await readLogTail(viewingJob!.logFile);
				renderLogViewer(viewingJob!, lines);
				return;
			}
			if (key.name === 'r' && viewingJob && (viewingJob.status === 'failed' || viewingJob.status === 'stopped')) {
				const job = viewingJob;
				closeLogViewer();
				clearScreen();
				console.log(chalk.bold(`Retrying ${job.ticketKey}...`));

				const agentOpt = job.agentOptionId ? resolveAgentOptionById(job.agentOptionId) : null;
				if (!agentOpt) {
					console.log(chalk.red(`  Could not resolve agent "${job.agent}". Return to job list.`));
					await new Promise((r) => setTimeout(r, 1500));
					await openJobList();
					return;
				}

				isAwaitingInput = true;
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				try {
					const detail = await fetchIssueDetail(job.ticketKey);
					const repoPaths = new Map<string, string>();
					for (const p of job.repos) repoPaths.set(p, p);

					await launchAgentInBackground(detail, agentOpt, repoPaths);
					await refreshJobStatuses();
					console.log(chalk.green(`  ✓ ${job.ticketKey} relaunched in background`));
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					console.log(chalk.red(`  Failed to retry: ${msg}`));
				} finally {
					isAwaitingInput = false;
					if (process.stdin.isTTY) process.stdin.setRawMode(true);
				}

				await new Promise((r) => setTimeout(r, 1500));
				await openJobList();
				return;
			}
			return;
		}

		if (inJobList) {
			if (key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
				inJobList = false;
				await refreshJobStatuses();
				redrawList();
				return;
			}
			if (key.name === 'up' && jobListItems.length) {
				selectedJobIndex = selectedJobIndex === 0 ? jobListItems.length - 1 : selectedJobIndex - 1;
				renderJobList(jobListItems, selectedJobIndex, selectedJobIds);
				return;
			}
			if (key.name === 'down' && jobListItems.length) {
				selectedJobIndex = selectedJobIndex === jobListItems.length - 1 ? 0 : selectedJobIndex + 1;
				renderJobList(jobListItems, selectedJobIndex, selectedJobIds);
				return;
			}
			if (key.name === 'space' && jobListItems.length) {
				const selectedJob = jobListItems[selectedJobIndex];
				if (selectedJobIds.has(selectedJob.id)) selectedJobIds.delete(selectedJob.id);
				else selectedJobIds.add(selectedJob.id);
				renderJobList(jobListItems, selectedJobIndex, selectedJobIds);
				return;
			}
			if (key.name === 'v' && selectedJobIds.size > 0) {
				const selectedJobs = jobListItems.filter((job) => selectedJobIds.has(job.id));
				if (selectedJobs.length === 1) {
					await openLogViewer(selectedJobs[0]);
				} else if (selectedJobs.length > 1) {
					await openMultiLogViewer(selectedJobs);
				}
				return;
			}
			if ((key.name === 'return' || key.name === 'enter') && jobListItems.length) {
				const selectedJobs = selectedJobIds.size > 0
					? jobListItems.filter((job) => selectedJobIds.has(job.id))
					: [jobListItems[selectedJobIndex]];
				if (selectedJobs.length === 1) {
					await openLogViewer(selectedJobs[0]);
				} else if (selectedJobs.length > 1) {
					await openMultiLogViewer(selectedJobs);
				}
				return;
			}
			return;
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

		if (inMultiBrief) {
			if (key.name === 'b' || key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
				inMultiBrief = false;
				redrawList();
				return;
			}
			if (key.name === 'w' && !launchingAgent) {
				inMultiBrief = false;
				const selectedTickets = [...checkedIndices].map((i) => tickets[i]);

				const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
				if (defaultAgentId) {
					const defaultOption = resolveAgentOptionById(defaultAgentId);
					if (defaultOption && !INTERACTIVE_AGENT_IDS.has(defaultOption.id)) {
						launchingAgent = true;
						isAwaitingInput = true;
						if (process.stdin.isTTY) process.stdin.setRawMode(false);

						clearScreen();
						console.log(chalk.bold(`Launching ${selectedTickets.length} ticket(s) in background...`));

						try {
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
								redrawList();
								return;
							}

							await launchMultipleTicketsInBackground(validDetails, defaultOption);

							inMultiBrief = false;
							await refreshJobStatuses();
							await new Promise((r) => setTimeout(r, 1500));
							redrawList();
						} finally {
							if (process.stdin.isTTY) process.stdin.setRawMode(true);
							launchingAgent = false;
							isAwaitingInput = false;
						}
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
				renderMultiAgentPicker(selectedTickets, agentOptions, selectedAgentIndex);
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

					if (await isTicketRunning(selectedTicket.key)) {
						inAgentPicker = false;
						clearScreen();
						console.log(chalk.yellow(`  ${selectedTicket.key} already has an AI agent running. View it from the ticket list.`));
						console.log(chalk.gray('\n  Press any key to go back...'));
						return;
					}

					const selectedOption = agentOptions[selectedAgentIndex];
					lastAgentOption = selectedOption;
					inAgentPicker = false;

					clearScreen();
					console.log(chalk.bold(`Launching ${selectedOption.label} for ${selectedTicket.key}...`));

					isAwaitingInput = true;
					if (process.stdin.isTTY) process.stdin.setRawMode(false);
					let launchFailed = false;
					let launchErrorMessage = '';
					try {
						const repoPaths = await resolveRepoPathsFromUser(selectedDetail);
						lastResolvedPaths = repoPaths;
						await launchAgentInBackground(selectedDetail, selectedOption, repoPaths);
						await refreshJobStatuses();
					} catch (error) {
						launchFailed = true;
						launchErrorMessage = error instanceof Error ? error.message : String(error);
					} finally {
						isAwaitingInput = false;
						if (process.stdin.isTTY) process.stdin.setRawMode(true);
					}

					showPostAgentPrompt = true;
					postAgentMessage = launchFailed
						? chalk.red(`Failed to start ${selectedOption.label}: ${launchErrorMessage}`)
						: chalk.green(`${selectedOption.label} finished for ${selectedTicket.key}. Review output and choose next step.`);
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

				if (await isTicketRunning(selected.key)) {
					clearScreen();
					console.log(chalk.yellow(`  ${selected.key} already has an AI agent running. View it from the ticket list.`));
					console.log(chalk.gray('\n  Press any key to go back...'));
					return;
				}

				const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
				if (defaultAgentId) {
					const defaultOption = resolveAgentOptionById(defaultAgentId);
					if (defaultOption) {
						lastAgentOption = defaultOption;
						clearScreen();
						console.log(chalk.bold(`Launching ${defaultOption.label} for ${selected.key}...`));

						isAwaitingInput = true;
						if (process.stdin.isTTY) process.stdin.setRawMode(false);
						let wLaunchFailed = false;
						let wLaunchError = '';
						try {
							const repoPaths = await resolveRepoPathsFromUser(selected.detail);
							lastResolvedPaths = repoPaths;
							await launchAgentInBackground(selected.detail, defaultOption, repoPaths);
							await refreshJobStatuses();
						} catch (error) {
							wLaunchFailed = true;
							wLaunchError = error instanceof Error ? error.message : String(error);
						} finally {
							isAwaitingInput = false;
							if (process.stdin.isTTY) process.stdin.setRawMode(true);
						}

						showPostAgentPrompt = true;
						postAgentMessage = wLaunchFailed
							? chalk.red(`Failed to start ${defaultOption.label}: ${wLaunchError}`)
							: chalk.green(`${defaultOption.label} finished for ${selected.key}. Review output and choose next step.`);
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
					console.log(chalk.gray('Install one of: copilot, cursor, claude, gemini, codex, aider'));
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

				clearScreen();
				console.log(chalk.bold(`Launching ${selectedTickets.length} ticket(s) in background...`));

				isAwaitingInput = true;
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				try {
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
						redrawList();
						return;
					}

					await launchMultipleTicketsInBackground(validDetails, selectedOption);

					await refreshJobStatuses();
					await new Promise((r) => setTimeout(r, 1500));
					redrawList();
				} finally {
					isAwaitingInput = false;
					if (process.stdin.isTTY) process.stdin.setRawMode(true);
				}
				return;
			}
			return;
		}

		if (key.name === 'q') {
			cleanup();
			process.exit(0);
		}

		if (key.name === 'l' && !loadingDetail && !loadingMore && !launchingAgent) {
			await openJobList();
			return;
		}

		if (key.name === 'v' && !loadingDetail && !loadingMore && !launchingAgent && tickets.length) {
			const selectedTicketKeys = checkedIndices.size > 0
				? [...checkedIndices].map((i) => tickets[i]?.key).filter((k): k is string => Boolean(k))
				: [tickets[selectedIndex]?.key].filter((k): k is string => Boolean(k));
			await openLogsForTicketKeys(selectedTicketKeys);
			return;
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

					clearScreen();
					console.log(chalk.bold(`Launching ${selectedTickets.length} ticket(s) in background...`));

					isAwaitingInput = true;
					if (process.stdin.isTTY) process.stdin.setRawMode(false);
					try {
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
							redrawList();
							return;
						}

						await launchMultipleTicketsInBackground(validDetails, defaultOption);

						await refreshJobStatuses();
						await new Promise((r) => setTimeout(r, 1500));
						redrawList();
					} finally {
						isAwaitingInput = false;
						if (process.stdin.isTTY) process.stdin.setRawMode(true);
					}
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

		if (!tickets.length || loadingDetail || loadingMore || launchingAgent) return;

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
			if (checkedIndices.size <= 1 && tickets[selectedIndex] && jobStatusMap.has(tickets[selectedIndex].key)) {
				await openLogsForTicketKeys([tickets[selectedIndex].key]);
				return;
			}

			if (checkedIndices.size > 1) {
				const selectedTickets = [...checkedIndices].map((i) => tickets[i]);
				const skipDetail = (process.env.FORGEPILOT_SKIP_DETAIL ?? '').trim().toLowerCase() === 'true';

				if (skipDetail) {
					const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
					if (defaultAgentId) {
						const defaultOption = resolveAgentOptionById(defaultAgentId);
						if (defaultOption && !INTERACTIVE_AGENT_IDS.has(defaultOption.id)) {
							clearScreen();
							console.log(chalk.bold(`Launching ${selectedTickets.length} ticket(s) in background...`));

							isAwaitingInput = true;
							if (process.stdin.isTTY) process.stdin.setRawMode(false);
							try {
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
									redrawList();
									return;
								}

								await launchMultipleTicketsInBackground(validDetails, defaultOption);

								await refreshJobStatuses();
								await new Promise((r) => setTimeout(r, 1500));
								redrawList();
							} finally {
								isAwaitingInput = false;
								if (process.stdin.isTTY) process.stdin.setRawMode(true);
							}
							return;
						}
					}
				}

				inMultiBrief = true;
				renderMultiTicketBrief(selectedTickets);
				return;
			}

			const selected = tickets[selectedIndex];
			loadingDetail = true;
			const willSkipDetail =
				(process.env.FORGEPILOT_SKIP_DETAIL ?? '').trim().toLowerCase() === 'true' &&
				!!process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
			if (!willSkipDetail) {
				clearScreen();
				console.log(`Loading ${selected.key} details...`);
			}
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

			const skipDetail = (process.env.FORGEPILOT_SKIP_DETAIL ?? '').trim().toLowerCase() === 'true';
			const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();

			if (skipDetail && defaultAgentId && selected.detail) {
				if (await isTicketRunning(selected.key)) {
					clearScreen();
					console.log(chalk.yellow(`  ${selected.key} already has an AI agent running.`));
					await new Promise((r) => setTimeout(r, 1500));
					redrawList();
					return;
				}

				const defaultOption = resolveAgentOptionById(defaultAgentId);
				if (defaultOption) {
					lastAgentOption = defaultOption;
					clearScreen();
					console.log(chalk.bold(`Launching ${defaultOption.label} for ${selected.key} in background...`));

					isAwaitingInput = true;
					if (process.stdin.isTTY) process.stdin.setRawMode(false);
					try {
						const repoPaths = await resolveRepoPathsFromUser(selected.detail);
						lastResolvedPaths = repoPaths;
						await launchAgentInBackground(selected.detail, defaultOption, repoPaths);
						await refreshJobStatuses();
						console.log(chalk.green(`  ✓ ${defaultOption.label} launched in background for ${selected.key}`));
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						console.log(chalk.red(`  Failed to launch: ${msg}`));
					} finally {
						isAwaitingInput = false;
						if (process.stdin.isTTY) process.stdin.setRawMode(true);
					}

					await new Promise((r) => setTimeout(r, 1500));
					redrawList();
					return;
				}
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
