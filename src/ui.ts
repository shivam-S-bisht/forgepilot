import chalk from 'chalk';
import {
	boardSprintText,
	colorStatus,
	commentsText,
	getAcceptanceCriteria,
	getDescriptionText,
	linkedIssuesText,
} from './jira-text.js';
import type { TicketView, WorkAgentOption } from './types.js';

const LIST_PAGE_SIZE = 20;

export { LIST_PAGE_SIZE };

export interface ScopeOption {
	id: string;
	label: string;
	description: string;
}

export function renderScopePicker(options: ScopeOption[], selectedIndex: number) {
	clearScreen();
	console.log(chalk.bold('ForgePilot'));
	console.log(chalk.gray('Which tickets do you want to work with?'));
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
	ticketKey: string,
) {
	clearScreen();
	console.log(chalk.bold(`Select repo(s) for ${ticketKey}`));
	console.log(chalk.gray('No repository URLs found in ticket description.'));
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

export function renderList(tickets: TicketView[], selectedIndex: number, expandedScope = false) {
	clearScreen();
	console.log(chalk.bold('My Jira Tickets'));
	console.log(
		chalk.gray(
			expandedScope
				? 'Scope: all assigned tickets (across boards, no subtasks)'
				: 'Scope: unresolved assigned tickets (across boards, no subtasks)',
		),
	);
	console.log(chalk.gray('Keys: ↑/↓ navigate, Enter details, m load more, q quit'));
	console.log(chalk.gray('='.repeat(90)));

	if (!tickets.length) {
		console.log('No assigned tickets found in current or future sprints.');
		return;
	}

	const pageStart = Math.floor(selectedIndex / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
	const pageEnd = Math.min(pageStart + LIST_PAGE_SIZE, tickets.length);

	for (let i = pageStart; i < pageEnd; i += 1) {
		const t = tickets[i];
		const isSelected = i === selectedIndex;
		const pointer = isSelected ? chalk.bold.cyan('▶') : ' ';
		const keyLabel = isSelected ? chalk.bold.white(t.key) : chalk.white(t.key);
		const titleLabel = isSelected ? chalk.bold(t.title) : chalk.gray(t.title);
		console.log(`${pointer} ${keyLabel}  ${titleLabel}`);
	}

	console.log(chalk.gray('-'.repeat(90)));
	if (tickets.length > LIST_PAGE_SIZE) {
		console.log(chalk.gray(`Showing ${pageStart + 1}-${pageEnd} of ${tickets.length}`));
	} else {
		console.log(chalk.gray(`Total: ${tickets.length}`));
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
