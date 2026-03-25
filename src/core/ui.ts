import chalk from 'chalk';
import {
	boardSprintText,
	colorStatus,
	commentsText,
	getAcceptanceCriteria,
	getDescriptionText,
	linkedIssuesText,
} from '../tools/jira/jira-text.js';
import type { TicketRunStatus, TicketView, WorkAgentOption } from './types.js';
import type { JobRecord, JobStatus } from './job-manager.js';

const LIST_PAGE_SIZE = 20;

export { LIST_PAGE_SIZE };

export interface ScopeOption {
	id: string;
	label: string;
	description: string;
}

export function renderScopePicker(
	options: ScopeOption[],
	selectedIndex: number,
	title = 'ForgePilot',
	subtitle = 'Which tickets do you want to work with?',
) {
	clearScreen();
	console.log(chalk.bold(title));
	if (subtitle) console.log(chalk.gray(subtitle));
	console.log(chalk.gray('Use ↑/↓ to navigate, Enter to select.'));
	console.log(chalk.gray('='.repeat(60)));
	console.log();
	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		const isSelected = i === selectedIndex;
		const pointer = isSelected ? chalk.bold.cyan('▶') : ' ';
		const label = isSelected ? chalk.bold.white(opt.label) : chalk.white(opt.label);
		const desc = chalk.gray(opt.description);
		console.log(`${pointer} ${label}`);
		console.log(`  ${desc}`);
	}
	console.log();
	console.log(chalk.gray('='.repeat(60)));
}

export function renderRepoPicker(
	repos: string[],
	cursorIndex: number,
	selectedIndices: Set<number>,
	title: string,
) {
	clearScreen();
	console.log(chalk.bold(title));
	console.log(chalk.gray('Use ↑/↓ to navigate, Space to toggle, Enter to confirm.'));
	console.log(chalk.gray('='.repeat(70)));
	console.log();

	const pageSize = 15;
	const pageStart = Math.floor(cursorIndex / pageSize) * pageSize;
	const pageEnd = Math.min(pageStart + pageSize, repos.length);

	for (let i = pageStart; i < pageEnd; i++) {
		const isCursor = i === cursorIndex;
		const isChecked = selectedIndices.has(i);
		const pointer = isCursor ? chalk.bold.cyan('▶') : ' ';
		const checkbox = isChecked ? chalk.green('◉') : chalk.gray('○');
		const label = isCursor ? chalk.bold.white(repos[i]) : chalk.white(repos[i]);
		console.log(`${pointer} ${checkbox} ${label}`);
	}

	console.log();
	if (repos.length > pageSize) {
		console.log(chalk.gray(`Showing ${pageStart + 1}-${pageEnd} of ${repos.length}`));
	}
	const count = selectedIndices.size;
	console.log(chalk.gray(`${count} repo(s) selected`));
	console.log(chalk.gray('='.repeat(70)));
}

export function clearScreen() {
	process.stdout.write('\x1Bc');
}

export function renderAgentPicker(ticket: TicketView, options: WorkAgentOption[], selected: number) {
	clearScreen();
	console.log(chalk.bold(`Start Work: ${ticket.key} - ${ticket.title}`));
	console.log(chalk.gray('Use ↑/↓ to choose an agent, Enter to launch, Esc/q to cancel.'));
	console.log(chalk.gray('='.repeat(90)));
	for (let i = 0; i < options.length; i += 1) {
		const option = options[i];
		const isSelected = i === selected;
		const pointer = isSelected ? chalk.bold.cyan('▶') : ' ';
		const label = isSelected ? chalk.bold.white(option.label) : chalk.white(option.label);
		const desc = chalk.gray(option.description);
		console.log(`${pointer} ${label}`);
		console.log(`  ${desc}`);
	}
	console.log(chalk.gray('-'.repeat(90)));
}

export function renderPostAgentPrompt(ticket: TicketView, message: string) {
	clearScreen();
	console.log(chalk.bold(`Agent Finished: ${ticket.key} - ${ticket.title}`));
	console.log(chalk.gray('='.repeat(90)));
	console.log(message);
	console.log();
	console.log(chalk.white('  p  Push branch & create MR/PR'));
	console.log(chalk.white('  r  Retry same agent'));
	console.log(chalk.white('  d  Back to ticket details'));
	console.log(chalk.white('  b  Back to ticket listing'));
	console.log(chalk.gray('='.repeat(90)));
}

function jobStatusBadge(status: JobStatus): string {
	switch (status) {
		case 'running':
			return chalk.cyan('⟳ AI Working');
		case 'done':
			return chalk.green('✓ AI Done');
		case 'failed':
			return chalk.red('✗ AI Failed');
		case 'stopped':
			return chalk.yellow('■ Stopped');
	}
}

export function renderList(
	tickets: TicketView[],
	selectedIndex: number,
	expandedScope = false,
	checkedIndices?: Set<number>,
	jobStatuses?: Map<string, JobStatus>,
) {
	clearScreen();
	console.log(chalk.bold('My Jira Tickets'));
	console.log(
		chalk.gray(
			expandedScope
				? 'Scope: all assigned tickets (across boards, no subtasks)'
				: 'Scope: unresolved assigned tickets (across boards, no subtasks)',
		),
	);
	const keyHints = checkedIndices
		? 'Keys: ↑/↓ navigate, Space toggle, a select all, Enter details, w work, l jobs, q quit'
		: 'Keys: ↑/↓ navigate, Space toggle, Enter details, m more, l jobs, q quit';
	console.log(chalk.gray(keyHints));
	console.log(chalk.gray('='.repeat(90)));

	if (!tickets.length) {
		console.log('No assigned tickets found in current or future sprints.');
		return;
	}

	const pageStart = Math.floor(selectedIndex / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
	const pageEnd = Math.min(pageStart + LIST_PAGE_SIZE, tickets.length);

	for (let i = pageStart; i < pageEnd; i += 1) {
		const t = tickets[i];
		const isCursor = i === selectedIndex;
		const pointer = isCursor ? chalk.bold.cyan('▶') : ' ';
		const isChecked = checkedIndices?.has(i);
		const jobStatus = jobStatuses?.get(t.key);

		let checkbox: string;
		if (jobStatus) {
			checkbox = jobStatusBadge(jobStatus);
		} else {
			checkbox = isChecked ? chalk.green('◉') : chalk.gray('○');
		}

		const keyLabel = isCursor ? chalk.bold.white(t.key) : chalk.white(t.key);
		const titleLabel = isCursor ? chalk.bold(t.title) : chalk.gray(t.title);
		console.log(`${pointer} ${checkbox} ${keyLabel}  ${titleLabel}`);
	}

	console.log(chalk.gray('-'.repeat(90)));
	const checkedCount = checkedIndices?.size ?? 0;
	const runningCount = jobStatuses ? [...jobStatuses.values()].filter((s) => s === 'running').length : 0;
	const parts: string[] = [];
	if (checkedCount > 0) parts.push(`${checkedCount} selected`);
	if (runningCount > 0) parts.push(`${runningCount} AI running`);
	const countInfo = parts.length ? `  |  ${parts.join('  |  ')}` : '';
	if (tickets.length > LIST_PAGE_SIZE) {
		console.log(chalk.gray(`Showing ${pageStart + 1}-${pageEnd} of ${tickets.length}${countInfo}`));
	} else {
		console.log(chalk.gray(`Total: ${tickets.length}${countInfo}`));
	}
}

export function renderDetails(ticket: TicketView, boards: Map<number, string>) {
	clearScreen();
	const detail = ticket.detail;
	if (!detail) {
		console.log(`${ticket.key} - ${ticket.title}\n`);
		console.log('Could not load details.');
		console.log('\nPress Esc or q to go back, Ctrl+C to quit.');
		return;
	}

	console.log(chalk.bold(`${detail.key} - ${detail.fields.summary ?? '(no title)'}`));
	console.log(chalk.gray('='.repeat(90)));
	console.log(`Status: ${colorStatus(detail.fields.status?.name ?? 'Unknown')}`);
	console.log(`\nBoard + Sprint:\n${boardSprintText(detail, boards)}`);
	console.log(`\nDescription:\n${getDescriptionText(detail)}`);
	console.log(`\nAcceptance Criteria:\n${getAcceptanceCriteria(detail)}`);
	console.log(`\nLinked Tickets:\n${linkedIssuesText(detail)}`);
	console.log(`\nComments:\n${commentsText(detail)}`);
	console.log(chalk.gray('\nPress Esc/q back, w choose agent, m load more, Ctrl+C quit.'));
}

function statusIcon(status: TicketRunStatus['status']): string {
	switch (status) {
		case 'queued':
			return chalk.gray('◻');
		case 'running':
			return chalk.cyan('⟳');
		case 'done':
			return chalk.green('✓');
		case 'failed':
			return chalk.red('✗');
	}
}

function statusLabel(status: TicketRunStatus['status']): string {
	switch (status) {
		case 'queued':
			return chalk.gray('Queued');
		case 'running':
			return chalk.cyan.bold('Running');
		case 'done':
			return chalk.green('Done');
		case 'failed':
			return chalk.red('Failed');
	}
}

export function renderMultiTicketDashboard(statuses: TicketRunStatus[]) {
	clearScreen();
	const done = statuses.filter((s) => s.status === 'done').length;
	const failed = statuses.filter((s) => s.status === 'failed').length;
	const running = statuses.filter((s) => s.status === 'running').length;
	const total = statuses.length;

	console.log(chalk.bold('ForgePilot — Parallel Execution Dashboard'));
	console.log(chalk.gray('='.repeat(90)));
	console.log(
		chalk.white(`  Total: ${total}  `) +
			chalk.cyan(`Running: ${running}  `) +
			chalk.green(`Done: ${done}  `) +
			chalk.red(`Failed: ${failed}`),
	);
	console.log(chalk.gray('-'.repeat(90)));
	console.log();

	for (const s of statuses) {
		const icon = statusIcon(s.status);
		const label = statusLabel(s.status);
		const repos = s.repos.map((r) => r.split('/').pop()).join(', ') || '(resolving)';
		console.log(`  ${icon} ${chalk.white.bold(s.ticketKey)}  ${chalk.gray(s.title.slice(0, 50))}`);
		console.log(`    ${label}  |  ${chalk.gray(s.agent)}  |  ${chalk.gray(repos)}`);
		if (s.error) {
			console.log(`    ${chalk.red(s.error.slice(0, 120))}`);
		}
	}

	console.log();
	console.log(chalk.gray('='.repeat(90)));
	if (done + failed < total) {
		console.log(chalk.gray('Agents are running in parallel. Waiting for completion...'));
	}
}

export function renderMultiTicketSummary(statuses: TicketRunStatus[]) {
	clearScreen();
	const done = statuses.filter((s) => s.status === 'done').length;
	const failed = statuses.filter((s) => s.status === 'failed').length;

	console.log(chalk.bold('ForgePilot — Parallel Execution Complete'));
	console.log(chalk.gray('='.repeat(90)));
	console.log(
		chalk.white(`  ${done} succeeded  `) + chalk.red(`${failed} failed  `) + chalk.gray(`of ${statuses.length}`),
	);
	console.log(chalk.gray('-'.repeat(90)));
	console.log();

	for (const s of statuses) {
		const icon = statusIcon(s.status);
		const repos = s.repos.map((r) => r.split('/').pop()).join(', ');
		console.log(`  ${icon} ${chalk.white.bold(s.ticketKey)}  ${chalk.gray(s.title.slice(0, 50))}`);
		console.log(`    ${chalk.gray(repos)}`);
		if (s.worktreePaths?.length) {
			for (const wt of s.worktreePaths) {
				console.log(`    ${chalk.gray(`worktree: ${wt}`)}`);
			}
		}
		if (s.error) {
			console.log(`    ${chalk.red(s.error.slice(0, 200))}`);
		}
	}

	console.log();
	console.log(chalk.gray('='.repeat(90)));
	console.log(chalk.white('  p  Push branches & create MR/PRs for all successful tickets'));
	console.log(chalk.white('  c  Cleanup worktrees'));
	console.log(chalk.white('  b  Back to ticket listing'));
	console.log(chalk.gray('='.repeat(90)));
}

export function renderMultiTicketBrief(selectedTickets: TicketView[]) {
	clearScreen();
	console.log(chalk.bold(`Selected Tickets (${selectedTickets.length})`));
	console.log(chalk.gray('='.repeat(90)));
	console.log();
	for (const t of selectedTickets) {
		const statusStr = t.status ? `  [${colorStatus(t.status)}]` : '';
		console.log(`  ${chalk.white.bold(t.key)}  ${chalk.gray(t.title)}${statusStr}`);
	}
	console.log();
	console.log(chalk.gray('='.repeat(90)));
	console.log(chalk.white('  w  Start work on all selected tickets'));
	console.log(chalk.white('  b  Back to ticket listing'));
	console.log(chalk.gray('='.repeat(90)));
}

export function renderMultiAgentPicker(
	selectedTickets: TicketView[],
	options: WorkAgentOption[],
	selected: number,
) {
	clearScreen();
	console.log(chalk.bold(`Start Work: ${selectedTickets.length} ticket(s) in parallel`));
	console.log(chalk.gray(selectedTickets.map((t) => t.key).join(', ')));
	console.log(chalk.gray('Use ↑/↓ to choose an agent, Enter to launch, Esc/q to cancel.'));
	console.log(chalk.gray('Only autonomous agents are available for parallel execution.'));
	console.log(chalk.gray('='.repeat(90)));
	for (let i = 0; i < options.length; i += 1) {
		const option = options[i];
		const isSelected = i === selected;
		const pointer = isSelected ? chalk.bold.cyan('▶') : ' ';
		const label = isSelected ? chalk.bold.white(option.label) : chalk.white(option.label);
		const desc = chalk.gray(option.description);
		console.log(`${pointer} ${label}`);
		console.log(`  ${desc}`);
	}
	console.log(chalk.gray('-'.repeat(90)));
}

const LOG_TAIL_LINES = 30;

export function renderLogViewer(job: JobRecord, logLines: string[]) {
	clearScreen();
	const statusBadge = jobStatusBadge(job.status);
	console.log(chalk.bold(`${job.ticketKey}: ${job.title}`));
	console.log(`  Agent: ${chalk.cyan(job.agent)}  |  Status: ${statusBadge}  |  PID: ${job.pid}`);
	console.log(chalk.gray(`  Log: ${job.logFile}`));
	console.log(chalk.gray('='.repeat(90)));

	const tail = logLines.slice(-LOG_TAIL_LINES);
	if (tail.length === 0) {
		console.log(chalk.gray('  (no output yet)'));
	} else {
		for (const line of tail) {
			console.log(chalk.white(`  ${line}`));
		}
	}

	console.log(chalk.gray('='.repeat(90)));
	const actions: string[] = ['q/Esc back'];
	if (job.status === 'running') {
		actions.push('s stop agent');
	}
	if (job.status === 'failed' || job.status === 'stopped') {
		actions.push('r retry/resume');
	}
	console.log(chalk.gray(`  Keys: ${actions.join('  |  ')}`));
}

export function renderJobList(jobs: JobRecord[], selectedIndex: number) {
	clearScreen();
	console.log(chalk.bold('Background Jobs'));
	console.log(chalk.gray('Keys: ↑/↓ navigate, Enter view logs, q back'));
	console.log(chalk.gray('='.repeat(90)));

	if (!jobs.length) {
		console.log(chalk.gray('  No background jobs.'));
		console.log(chalk.gray('='.repeat(90)));
		return;
	}

	for (let i = 0; i < jobs.length; i++) {
		const j = jobs[i];
		const pointer = i === selectedIndex ? chalk.bold.cyan('▶') : ' ';
		const badge = jobStatusBadge(j.status);
		const key = i === selectedIndex ? chalk.bold.white(j.ticketKey) : chalk.white(j.ticketKey);
		const title = i === selectedIndex ? chalk.bold(j.title) : chalk.gray(j.title);
		console.log(`${pointer} ${badge}  ${key}  ${title}`);
	}
	console.log(chalk.gray('-'.repeat(90)));
}

// ---------------------------------------------------------------------------
// Sub-agent monitor (interactive dashboard during parallel execution)
// ---------------------------------------------------------------------------

export interface SubAgentEntry {
	index: number;
	status: 'running' | 'done' | 'failed';
	taskCount: number;
	tasks: string[];
	logFile: string;
	pid: number;
}

export function renderSubAgentDashboard(
	ticketKey: string,
	waveIndex: number,
	totalWaves: number,
	agents: SubAgentEntry[],
	selectedIndex: number,
	elapsedSec: number,
) {
	clearScreen();
	const mins = Math.floor(elapsedSec / 60);
	const secs = elapsedSec % 60;
	const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

	const running = agents.filter((a) => a.status === 'running').length;
	const done = agents.filter((a) => a.status === 'done').length;
	const failed = agents.filter((a) => a.status === 'failed').length;

	console.log(chalk.bold(`${ticketKey} — Wave ${waveIndex + 1}/${totalWaves}: ${agents.length} sub-agent(s)`));
	console.log(chalk.gray(`  ⏱ ${timeStr}  |  ${chalk.cyan(`${running} running`)}  ${chalk.green(`${done} done`)}  ${chalk.red(`${failed} failed`)}`));
	console.log(chalk.gray('Keys: ↑/↓ navigate, Enter view logs, q/Esc close monitor'));
	console.log(chalk.gray('='.repeat(90)));

	for (let i = 0; i < agents.length; i++) {
		const a = agents[i];
		const pointer = i === selectedIndex ? chalk.bold.cyan('▶') : ' ';
		let badge: string;
		switch (a.status) {
			case 'running': badge = chalk.cyan('⟳ Working'); break;
			case 'done': badge = chalk.green('✓ Done'); break;
			case 'failed': badge = chalk.red('✗ Failed'); break;
		}
		const label = i === selectedIndex
			? chalk.bold.white(`Agent ${a.index + 1}`)
			: chalk.white(`Agent ${a.index + 1}`);
		const detail = i === selectedIndex
			? chalk.bold(`${a.taskCount} task(s) — PID ${a.pid}`)
			: chalk.gray(`${a.taskCount} task(s) — PID ${a.pid}`);
		console.log(`${pointer} ${badge}  ${label}  ${detail}`);

		if (i === selectedIndex) {
			for (const task of a.tasks) {
				console.log(chalk.gray(`     • ${task}`));
			}
		}
	}
	console.log(chalk.gray('-'.repeat(90)));
}

export function renderSubAgentLogViewer(
	ticketKey: string,
	agentIndex: number,
	status: 'running' | 'done' | 'failed',
	logLines: string[],
) {
	clearScreen();
	const badge = status === 'running' ? chalk.cyan('⟳ Working')
		: status === 'done' ? chalk.green('✓ Done')
		: chalk.red('✗ Failed');

	console.log(chalk.bold(`${ticketKey} — Agent ${agentIndex + 1} Logs`));
	console.log(`  Status: ${badge}`);
	console.log(chalk.gray('='.repeat(90)));

	const tail = logLines.slice(-LOG_TAIL_LINES);
	if (tail.length === 0) {
		console.log(chalk.gray('  (no output yet)'));
	} else {
		for (const line of tail) {
			console.log(chalk.white(`  ${line}`));
		}
	}

	console.log(chalk.gray('='.repeat(90)));
	console.log(chalk.gray('  Keys: q/Esc back to dashboard'));
}
