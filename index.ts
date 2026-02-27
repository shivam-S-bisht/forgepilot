#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);
const LIST_PAGE_SIZE = 20;
const DEFAULT_AC_FIELD_IDS = ['customfield_13223', 'customfield_10039'];
const DEFAULT_TICKETS_JQL = 'assignee = currentUser() AND issuetype NOT IN subTaskIssueTypes() AND resolution = Unresolved ORDER BY updated DESC';
const LOAD_MORE_TICKETS_JQL = 'assignee = currentUser() AND issuetype NOT IN subTaskIssueTypes() ORDER BY updated DESC';

type JiraBoard = {
	id: number;
	name: string;
};

type JiraIssueSummary = {
	key: string;
	id?: string;
	fields?: {
		summary?: string;
		status?: { name?: string };
	};
};

type JiraIssueDetail = {
	key: string;
	self?: string;
	fields: Record<string, unknown> & {
		summary?: string;
		status?: { name?: string };
		description?: unknown;
		comment?: { comments?: Array<{ body?: unknown; created?: string; author?: { displayName?: string } }> };
		issuelinks?: Array<{
			type?: { inward?: string; outward?: string };
			inwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
			outwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
		}>;
	};
};

type SprintInfo = {
	id: number;
	name: string;
	state?: string;
	boardId?: number;
};

type TicketView = {
	key: string;
	title: string;
	status: string;
	detail?: JiraIssueDetail;
};

type WorkAgentOption = {
	id: 'copilot-autonomous' | 'copilot-interactive' | 'rovo-autonomous' | 'cursor-autonomous';
	label: string;
	description: string;
};

function clearScreen() {
	process.stdout.write('\x1Bc');
}

function askLine(prompt: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) =>
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		}),
	);
}

function normalizeRepoUrl(raw: string): string {
	if (!raw) return '';
	let value = raw.trim().replace(/[),.;]+$/, '');
	const ssh = value.match(/^git@([^:]+):(.+)$/);
	if (ssh) value = `${ssh[1]}/${ssh[2]}`;
	else {
		try {
			const u = new URL(value);
			value = `${u.hostname}${u.pathname}`;
		} catch {
			// Not a valid URL; keep as-is.
		}
	}
	return value.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

function extractRepoLabels(text: string): Array<{ label: string; normalizedUrl: string }> {
	const urlRegex = /(https?:\/\/[^\s\])]+|git@[^\s\])]+)/gi;
	const results: Array<{ label: string; normalizedUrl: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = urlRegex.exec(text)) !== null) {
		const rawUrl = match[1];
		const normalized = normalizeRepoUrl(rawUrl);
		if (!normalized) continue;
		const slug = normalized.split('/').pop() ?? normalized;
		if (!results.some((r) => r.normalizedUrl === normalized)) {
			results.push({ label: slug, normalizedUrl: normalized });
		}
	}
	return results;
}

async function resolveRepoPathsFromUser(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const description = getDescriptionText(detail);
	const repos = extractRepoLabels(description);
	const repoMap = new Map<string, string>();

	if (!repos.length) {
		console.log(chalk.yellow('\nNo repository URLs found in ticket description.'));
		const manualPath = await askLine('Enter the local repo path to work in: ');
		if (!manualPath) throw new Error('No repo path provided.');
		const resolved = path.resolve(manualPath);
		if (!existsSync(path.join(resolved, '.git'))) throw new Error(`Not a git repository: ${resolved}`);
		repoMap.set('manual', resolved);
		return repoMap;
	}

	console.log(chalk.bold(`\nFound ${repos.length} repo(s) in ticket description:`));
	for (const repo of repos) {
		console.log(chalk.cyan(`  ${repo.label} (${repo.normalizedUrl})`));
	}
	console.log('');

	for (const repo of repos) {
		const localPath = await askLine(`Local path for ${chalk.bold(repo.label)} (${repo.normalizedUrl}): `);
		if (!localPath) throw new Error(`No path provided for ${repo.label}.`);
		const resolved = path.resolve(localPath);
		if (!existsSync(path.join(resolved, '.git'))) throw new Error(`Not a git repository: ${resolved}`);
		repoMap.set(repo.normalizedUrl, resolved);
	}

	return repoMap;
}

function splitConcatenatedJsonDocuments(raw: string): string[] {
	const documents: string[] = [];
	const text = raw.trim();
	if (!text) return documents;

	let startIndex = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (startIndex === -1) {
			if (ch === '{' || ch === '[') {
				startIndex = i;
				depth = 1;
			}
			continue;
		}

		if (ch === '{' || ch === '[') {
			depth += 1;
		} else if (ch === '}' || ch === ']') {
			depth -= 1;
			if (depth === 0) {
				documents.push(text.slice(startIndex, i + 1));
				startIndex = -1;
			}
		}
	}

	return documents;
}

async function runAcliJson<T>(args: string[]): Promise<T> {
	try {
		const { stdout } = await execFileAsync('acli', args, { maxBuffer: 20 * 1024 * 1024 });

		try {
			return JSON.parse(stdout) as T;
		} catch {
			const docs = splitConcatenatedJsonDocuments(stdout);
			if (!docs.length) {
				throw new Error('Could not parse JSON output from acli.');
			}
			if (docs.length === 1) {
				return JSON.parse(docs[0]) as T;
			}

			const parsed = docs.map((doc) => JSON.parse(doc));
			if (parsed.every((item) => Array.isArray(item))) {
				return parsed.flat() as T;
			}

			return parsed as T;
		}
	} catch (error: unknown) {
		if (error && typeof error === 'object' && 'stdout' in error) {
			const errObj = error as Record<string, unknown>;
			const maybeStdout = String(errObj.stdout ?? '');
			const maybeStderr = String(errObj.stderr ?? '');
			throw new Error(`acli failed for "${args.join(' ')}": ${maybeStderr || maybeStdout || 'unknown error'}`);
		}
		throw error;
	}
}

async function fetchBoards(): Promise<Map<number, string>> {
	const response = await runAcliJson<Array<{ values?: JiraBoard[] }> | { values?: JiraBoard[] }>(['jira', 'board', 'search', '--paginate', '--json']);
	const boardMap = new Map<number, string>();

	const pages = Array.isArray(response) ? response : [response];
	for (const page of pages) {
		for (const board of page.values ?? []) {
			boardMap.set(board.id, board.name);
		}
	}

	return boardMap;
}

async function fetchMyCurrentAndFutureSprintIssues(): Promise<TicketView[]> {
	return fetchTicketsByJql(DEFAULT_TICKETS_JQL);
}

async function fetchTicketsByJql(jql: string): Promise<TicketView[]> {
	const issues = await runAcliJson<JiraIssueSummary[]>([
		'jira',
		'workitem',
		'search',
		'--jql',
		jql,
		'--fields',
		'key,summary,status',
		'--paginate',
		'--json',
	]);

	return issues.map((issue) => ({
		key: issue.key,
		title: issue.fields?.summary ?? '(no title)',
		status: issue.fields?.status?.name ?? 'Unknown',
	}));
}

async function fetchIssueDetail(issueKey: string): Promise<JiraIssueDetail> {
	return runAcliJson<JiraIssueDetail>(['jira', 'workitem', 'view', issueKey, '--fields', '*all', '--json']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adfToText(node: any): string {
	if (!node) return '';
	if (typeof node === 'string') return node;
	if (Array.isArray(node)) return node.map((item) => adfToText(item)).join('');

	switch (node.type) {
		case 'text':
			return node.text ?? '';
		case 'hardBreak':
			return '\n';
		case 'inlineCard':
			return node.attrs?.url ?? '';
		case 'paragraph':
		case 'heading':
			return `${adfToText(node.content ?? [])}\n`;
		case 'bulletList':
			return (node.content ?? [])
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map((item: any) => `- ${adfToText(item.content ?? []).trim()}`)
				.join('\n')
				.concat('\n');
		case 'orderedList': {
			const items = node.content ?? [];
			return items
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map((item: any, index: number) => `${index + 1}. ${adfToText(item.content ?? []).trim()}`)
				.join('\n')
				.concat('\n');
		}
		case 'listItem':
			return adfToText(node.content ?? []);
		case 'doc':
			return adfToText(node.content ?? []);
		default:
			return adfToText(node.content ?? []);
	}
}

function extractAcceptanceCriteria(description: string): string {
	if (!description.trim()) return 'Not available';

	const regex = /(?:^|\n)(?:#+\s*)?(acceptance criteria|ac)\s*:?\s*\n([\s\S]*?)(?=\n(?:#+\s*)?[A-Za-z][A-Za-z0-9 _-]*\s*:?\s*\n|$)/i;
	const match = description.match(regex);
	if (!match?.[2]) return 'Not available';
	return match[2].trim();
}

function getDescriptionText(detail: JiraIssueDetail): string {
	const descriptionText = adfToText(detail.fields.description).trim();
	return descriptionText || 'Not available';
}

function getAcceptanceCriteria(detail: JiraIssueDetail): string {
	const configuredAcField = process.env.JIRA_AC_FIELD?.trim();
	const candidateFields = configuredAcField ? [configuredAcField] : DEFAULT_AC_FIELD_IDS;

	for (const fieldKey of candidateFields) {
		const fieldValue = detail.fields[fieldKey];
		if (!fieldValue) continue;
		const acText = adfToText(fieldValue).trim();
		if (acText) return acText;
	}

	return extractAcceptanceCriteria(getDescriptionText(detail));
}

function linkedIssuesText(detail: JiraIssueDetail): string {
	const links = detail.fields.issuelinks ?? [];
	if (!links.length) return 'None';

	return links
		.map((link) => {
			const target = link.outwardIssue ?? link.inwardIssue;
			if (!target?.key) return '';
			const relation = link.outwardIssue ? link.type?.outward : link.type?.inward;
			const summary = target.fields?.summary ?? '';
			const status = target.fields?.status?.name ?? 'Unknown';
			return `${target.key} (${status})${relation ? ` - ${relation}` : ''}${summary ? ` - ${summary}` : ''}`;
		})
		.filter(Boolean)
		.join('\n');
}

function commentsText(detail: JiraIssueDetail): string {
	const comments = detail.fields.comment?.comments ?? [];
	if (!comments.length) return 'No comments';

	return comments
		.map((comment, index) => {
			const author = comment.author?.displayName ?? 'Unknown';
			const created = comment.created ?? '';
			const body = adfToText(comment.body).trim();
			return `${index + 1}. ${author}${created ? ` (${created})` : ''}\n${body || '(empty comment)'}`;
		})
		.join('\n\n');
}

function extractSprintsFromFields(fields: Record<string, unknown>): SprintInfo[] {
	const sprints: SprintInfo[] = [];

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const maybeAddSprint = (value: any) => {
		if (!value || typeof value !== 'object') return;
		if (typeof value.id !== 'number' || typeof value.name !== 'string') return;

		// Detect sprint-like objects by checking common sprint keys.
		if (value.state !== undefined || value.startDate !== undefined || value.endDate !== undefined || value.boardId !== undefined) {
			sprints.push({
				id: value.id,
				name: value.name,
				state: typeof value.state === 'string' ? value.state : undefined,
				boardId: typeof value.boardId === 'number' ? value.boardId : undefined,
			});
		}
	};

	for (const value of Object.values(fields)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				maybeAddSprint(item);
			}
		} else {
			maybeAddSprint(value);
		}
	}

	const seen = new Set<number>();
	return sprints.filter((s) => {
		if (seen.has(s.id)) return false;
		seen.add(s.id);
		return true;
	});
}

function boardSprintText(detail: JiraIssueDetail, boards: Map<number, string>): string {
	const sprints = extractSprintsFromFields(detail.fields);
	if (!sprints.length) return 'Not available';

	return sprints
		.map((sprint) => {
			const boardName = sprint.boardId ? boards.get(sprint.boardId) ?? `Board #${sprint.boardId}` : 'Board unknown';
			const state = sprint.state ? ` (${sprint.state})` : '';
			return `${boardName} / ${sprint.name}${state}`;
		})
		.join('\n');
}

function colorStatus(status: string): string {
	const normalized = status.toLowerCase();
	if (normalized.includes('progress')) return chalk.yellow(status);
	if (normalized.includes('done') || normalized.includes('closed') || normalized.includes('resolved')) return chalk.green(status);
	if (normalized.includes('open') || normalized.includes('to do') || normalized.includes('triage')) return chalk.cyan(status);
	return chalk.white(status);
}

function getJiraBrowseUrl(detail: JiraIssueDetail): string {
	if (detail.self) {
		try {
			const origin = new URL(detail.self).origin;
			return `${origin}/browse/${detail.key}`;
		} catch {
			// Ignore parse errors and use fallback.
		}
	}
	return `https://clubautomation.atlassian.net/browse/${detail.key}`;
}

function buildWorkPrompt(detail: JiraIssueDetail, contributing = ''): string {
	const title = detail.fields.summary ?? '(no title)';
	const status = detail.fields.status?.name ?? 'Unknown';
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const links = linkedIssuesText(detail);

	const sections = [
		'Start implementing this Jira ticket in the current repository.',
		'Follow the repository contribution guidelines strictly.',
		'',
		`Ticket: ${detail.key} - ${title}`,
		`Status: ${status}`,
		'',
		'Description:',
		description,
		'',
		'Acceptance Criteria:',
		ac,
		'',
		'Linked Tickets:',
		links,
		'',
		'Execution requirements:',
		'- Follow CONTRIBUTING.md conventions.',
		];

	if (contributing) {
		sections.push('', '--- CONTRIBUTING.MD ---', contributing, '--- END CONTRIBUTING.MD ---');
	}

	return sections.join('\n');
}

async function runCommandInteractive(command: string, args: string[], toolName: string, cwd?: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
		child.on('error', (error: NodeJS.ErrnoException) => {
			if (error?.code === 'ENOENT') {
				reject(new Error(`${toolName} CLI is not installed or not in PATH.`));
				return;
			}
			reject(error);
		});
		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${toolName} CLI exited with code ${code ?? 'unknown'}`));
		});
	});
}

async function runCopilotForTicket(detail: JiraIssueDetail, repoPath: string, contributing: string, autonomous = false): Promise<void> {
	const prompt = buildWorkPrompt(detail, contributing);
	const args = autonomous
		? ['-p', prompt, '--autopilot', '--allow-all-tools', '--allow-all-paths', '--add-dir', repoPath]
		: ['-i', prompt, '--add-dir', repoPath];

	await runCommandInteractive('copilot', args, 'Copilot', repoPath);
}

async function runRovoForTicket(detail: JiraIssueDetail, repoPath: string, contributing: string): Promise<void> {
	const jiraUrl = getJiraBrowseUrl(detail);
	const prompt = buildWorkPrompt(detail, contributing);
	const args = ['rovodev', 'run', '--yolo', '--jira', jiraUrl, prompt];
	await runCommandInteractive('acli', args, 'Rovo', repoPath);
}

async function runCursorForTicket(detail: JiraIssueDetail, repoPath: string, contributing: string): Promise<void> {
	const prompt = buildWorkPrompt(detail, contributing);
	const args = ['agent', '--yolo', '--workspace', repoPath, '-p', prompt];
	await runCommandInteractive('cursor', args, 'Cursor Agent', repoPath);
}

async function gitExec(repoPath: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

async function prepareRepoForWork(repoPath: string, ticketKey: string): Promise<void> {
	const branchName = ticketKey.toLowerCase();

	console.log(chalk.gray(`  Checking for uncommitted changes in ${repoPath}...`));
	const status = await gitExec(repoPath, ['status', '--porcelain']);
	if (status) {
		console.log(chalk.yellow(`  Stashing ${status.split('\n').length} uncommitted change(s)...`));
		await gitExec(repoPath, ['stash', 'push', '-m', `forgepilot-auto-stash-before-${branchName}`]);
	}

	console.log(chalk.gray('  Fetching latest from remote...'));
	try {
		await gitExec(repoPath, ['fetch', '--prune']);
	} catch {
		console.log(chalk.yellow('  Warning: fetch failed, continuing with local state.'));
	}

	const defaultBranch = await detectDefaultBranch(repoPath);
	console.log(chalk.gray(`  Checking out ${defaultBranch} and pulling...`));
	await gitExec(repoPath, ['checkout', defaultBranch]);
	try {
		await gitExec(repoPath, ['pull', '--ff-only']);
	} catch {
		console.log(chalk.yellow(`  Warning: pull --ff-only failed on ${defaultBranch}, continuing.`));
	}

	const existingBranches = await gitExec(repoPath, ['branch', '--list', branchName]);
	if (existingBranches) {
		console.log(chalk.gray(`  Switching to existing branch ${branchName}...`));
		await gitExec(repoPath, ['checkout', branchName]);
	} else {
		console.log(chalk.gray(`  Creating new branch ${branchName}...`));
		await gitExec(repoPath, ['checkout', '-b', branchName]);
	}

	console.log(chalk.green(`  Ready on branch ${branchName}`));
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
	try {
		const ref = await gitExec(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
		return ref.replace('refs/remotes/origin/', '');
	} catch {
		// Fallback: check if main or master exists.
	}
	try {
		await gitExec(repoPath, ['rev-parse', '--verify', 'origin/main']);
		return 'main';
	} catch {
		// Not main.
	}
	try {
		await gitExec(repoPath, ['rev-parse', '--verify', 'origin/master']);
		return 'master';
	} catch {
		// Not master either.
	}
	return 'main';
}

async function readContributing(repoPath: string): Promise<string> {
	const candidates = ['CONTRIBUTING.md', 'AGENTS.md'];
	for (const filename of candidates) {
		const filePath = path.join(repoPath, filename);
		if (existsSync(filePath)) {
			try {
				const content = await fs.readFile(filePath, 'utf8');
				return content.slice(0, 12000);
			} catch {
				// Skip unreadable files.
			}
		}
	}
	return '';
}

async function launchAgentForRepos(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<void> {
	const paths = [...repoPaths.values()];
	for (const repoPath of paths) {
		console.log(chalk.bold(`\nPreparing ${repoPath} for ${detail.key}...`));
		await prepareRepoForWork(repoPath, detail.key);

		const contributing = await readContributing(repoPath);
		if (contributing) {
			console.log(chalk.gray(`  Found CONTRIBUTING.md / AGENTS.md in ${repoPath}`));
		}

		console.log(chalk.bold(`\nRunning ${agentOption.label} in ${repoPath} ...`));
		switch (agentOption.id) {
			case 'copilot-autonomous':
				await runCopilotForTicket(detail, repoPath, contributing, true);
				break;
			case 'copilot-interactive':
				await runCopilotForTicket(detail, repoPath, contributing, false);
				break;
			case 'rovo-autonomous':
				await runRovoForTicket(detail, repoPath, contributing);
				break;
			case 'cursor-autonomous':
				await runCursorForTicket(detail, repoPath, contributing);
				break;
		}
	}
}

function getWorkAgentOptions(): WorkAgentOption[] {
	return [
		{
			id: 'copilot-autonomous',
			label: 'Copilot (Autonomous)',
			description: 'Runs non-interactive with auto approvals.',
		},
		{
			id: 'copilot-interactive',
			label: 'Copilot (Interactive)',
			description: 'Starts chat mode with the ticket prompt prefilled.',
		},
		{
			id: 'rovo-autonomous',
			label: 'Rovo (Autonomous)',
			description: 'Runs acli rovodev with yolo mode.',
		},
		{
			id: 'cursor-autonomous',
			label: 'Cursor Agent (Autonomous)',
			description: 'Runs cursor agent in print + yolo mode.',
		},
	];
}

function renderAgentPicker(ticket: TicketView, options: WorkAgentOption[], selected: number) {
	clearScreen();
	console.log(chalk.bold(`Start Work: ${ticket.key} - ${ticket.title}`));
	console.log(chalk.gray('Use ↑/↓ to choose an agent, Enter to launch, Esc/q to cancel.'));
	console.log(chalk.gray('='.repeat(90)));
	for (let i = 0; i < options.length; i += 1) {
		const option = options[i];
		const isSelected = i === selected;
		const pointer = isSelected ? chalk.bold.cyan('▶') : ' ';
		const label = isSelected ? chalk.bold.white(option.label) : chalk.white(option.label);
		const desc = isSelected ? chalk.gray(option.description) : chalk.gray(option.description);
		console.log(`${pointer} ${label}`);
		console.log(`  ${desc}`);
	}
	console.log(chalk.gray('-'.repeat(90)));
}

function renderPostAgentPrompt(ticket: TicketView, message: string) {
	clearScreen();
	console.log(chalk.bold(`Agent Finished: ${ticket.key} - ${ticket.title}`));
	console.log(chalk.gray('='.repeat(90)));
	console.log(message);
	console.log(chalk.gray('\nGo back to ticket listing?'));
	console.log(chalk.gray('Press r to retry same agent, b to go back to listing, d to stay in ticket details.'));
}

function renderList(tickets: TicketView[], selectedIndex: number, expandedScope = false) {
	clearScreen();
	console.log(chalk.bold('My Jira Tickets'));
	console.log(
		chalk.gray(
			expandedScope ? 'Scope: all assigned tickets (across boards, no subtasks)' : 'Scope: unresolved assigned tickets (across boards, no subtasks)',
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

function renderDetails(ticket: TicketView, boards: Map<number, string>) {
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

async function startInteractiveCli(tickets: TicketView[], boards: Map<number, string>) {
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
					if (process.stdin.isTTY) {
						process.stdin.setRawMode(false);
					}

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
						if (process.stdin.isTTY) {
							process.stdin.setRawMode(true);
						}
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
				if (key.name === 'd' || key.name === 'q' || key.name === 'escape' || key.name === 'backspace' || key.name === 'return') {
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
					if (process.stdin.isTTY) {
						process.stdin.setRawMode(false);
					}

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
						if (process.stdin.isTTY) {
							process.stdin.setRawMode(true);
						}
						launchingAgent = false;
					}

					showPostAgentPrompt = true;
					postAgentMessage = launchFailed
						? chalk.red(`Failed to start ${selectedOption.label}: ${launchErrorMessage}`)
						: chalk.green(`${selectedOption.label} finished. Review output and choose next step.`);
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
				if (!selected.detail || launchingAgent) {
					return;
				}
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
					if (!byKey.has(t.key)) {
						byKey.set(t.key, t);
					}
				}
				tickets.splice(0, tickets.length, ...byKey.values());
				expandedScope = true;
				selectedIndex = Math.min(selectedIndex, Math.max(0, tickets.length - 1));
			} catch (error) {
				console.log(chalk.red(`Failed to load more tickets: ${error instanceof Error ? error.message : String(error)}`));
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

async function main() {
	try {
		console.log(chalk.bold('Fetching your Jira tickets...'));
		console.log(chalk.gray('Using authenticated acli session'));
		const [boards, tickets] = await Promise.all([fetchBoards(), fetchMyCurrentAndFutureSprintIssues()]);
		await startInteractiveCli(tickets, boards);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: ${message}`);
		console.error('\nMake sure `acli auth login` is completed and Jira access is available.');
		process.exit(1);
	}
}

main();
