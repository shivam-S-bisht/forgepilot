import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { unlinkSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';

import { matchCommand, VOICE_COMMANDS, type MatchedCommand } from './voice-commands.js';
import { fetchTicketsByScope, fetchTicketsByJql, createJiraIssue } from '../jira/jira.js';
import type { TicketScope } from '../jira/jira.js';
import { fetchIssueDetail, transitionIssueToInProgress } from '../jira/jira.js';
import { getDescriptionText, getAcceptanceCriteria, getJiraBrowseUrl } from '../jira/jira-text.js';
import { gitExec, findOpenPullRequest, fetchUnresolvedReviewComments, pushBranchAndCreateMR, prepareRepoForWork } from '../git/git.js';
import { parseTodoProgress, getAvailableAgentOptions, launchAgentForRepos, launchMultipleTickets, launchAgentForCustomTask, resolveAgentOptionById } from '../../core/agents.js';
import { getCached } from '../../core/cache.js';
import { resolveRepoPathsAuto, scanLocalRepos } from '../../core/repo.js';
import {
	checkVoiceDependencies,
	initRecognizer,
	speak,
	printAndSpeak,
	killTts,
	getSherpaModelDir,
	getSherpaModule,
	getSherpaRecognizer,
	setVoiceModeActive,
	askVoice,
	type VoiceOption,
} from './voice-input.js';

const execFileAsync = promisify(execFile);

const MIN_RECORDING_MS = 1000;
const KEY_DEBOUNCE_MS = 500;

type TicketListItem = { key: string; title: string; status: string };

const PAGE_SIZE = 10;

type VoiceState = {
	recProcess: ChildProcess | null;
	lastTicketKey: string | null;
	lastRepoPath: string | null;
	lastTicketList: TicketListItem[];
	ticketListPage: number;
	shouldExit: boolean;
	recording: boolean;
	recordingStartedAt: number;
	tempFile: string;
};

function resolveTicketKey(params: Record<string, string>, state: VoiceState): string | null {
	if (params.ticket_key) return params.ticket_key;

	const idxStr = params.ticket_index;
	if (idxStr !== undefined && state.lastTicketList.length > 0) {
		let idx = parseInt(idxStr, 10);
		const pageStart = state.ticketListPage * PAGE_SIZE;
		const pageEnd = Math.min(pageStart + PAGE_SIZE, state.lastTicketList.length);
		if (idx === -1) {
			idx = pageEnd - 1;
		} else {
			idx = pageStart + idx;
		}
		if (idx >= 0 && idx < state.lastTicketList.length) {
			return state.lastTicketList[idx].key;
		}
	}

	return state.lastTicketKey;
}

// ---------------------------------------------------------------------------
// AI Command Parser
// ---------------------------------------------------------------------------

type AiParsedCommand = {
	handler: string;
	params: Record<string, string>;
};

function buildAiPrompt(transcript: string, state: VoiceState): string {
	const ticketListContext = state.lastTicketList.length
		? state.lastTicketList
				.slice(
					state.ticketListPage * PAGE_SIZE,
					state.ticketListPage * PAGE_SIZE + PAGE_SIZE,
				)
				.map((t, i) => `  ${i + 1}. ${t.key} — ${t.title} [${t.status}]`)
				.join('\n')
		: '  (none)';

	return `You are a voice command parser for ForgePilot, a Jira + Git automation tool.
Given the user's spoken command, determine which action they want and extract all parameters.

Available actions (use the handler name exactly):
- listTickets: Fetch user's Jira tickets. Params: scope ("current-sprint" or "all-assigned"), jql (optional — a valid JQL query if the user wants tickets filtered by status, keyword, priority, etc. e.g. status = "At the Station")
- searchTickets: Search Jira with a query. Params: jql (a valid Jira JQL query string). Use this when the user wants to find specific tickets by keyword or complex criteria.
- getTicketDetails: Show details for a ticket. Params: ticket_key (e.g. "CE-1234")
- startTicket: Start working on ticket(s) with an AI agent. Params: ticket_key (single key), ticket_keys (comma-separated if multiple, e.g. "CE-124,CE-3791")
- pushAndCreatePR: Push branch and create a pull/merge request. Params: ticket_key
- checkStatus: Show git status and branch info. No params needed.
- showTodoProgress: Show todo checklist progress. Params: ticket_key
- checkReviewComments: Check PR/MR review comments. Params: ticket_key
- transitionTicket: Move a ticket to In Progress. Params: ticket_key
- commitChanges: Stage and commit all changes. Params: ticket_key
- prepareBranch: Create/checkout a feature branch. Params: ticket_key
- customTask: Work on a custom task without a Jira ticket. Params: description (a brief summary of the task the user wants to work on)
- showMore: Show next page of ticket list. No params.
- showHelp: List available commands. No params.
- stopVoice: Exit voice mode. No params.

Context:
- Last active ticket: ${state.lastTicketKey ?? '(none)'}
- Last repo path: ${state.lastRepoPath ? path.basename(state.lastRepoPath) : '(none)'}
- Currently displayed ticket list:
${ticketListContext}

When the user refers to "the second one", "first ticket", "last one", "that ticket", etc., resolve it to the correct ticket_key from the displayed list above.
When the user mentions a Jira status like "at the station", "in QA", "blocked", "in review", "triage", etc., generate proper JQL with the exact status name and use listTickets with the jql param.
For JQL queries, always include "assignee = currentUser() AND" prefix and "ORDER BY updated DESC" suffix.

User said: "${transcript}"

Return ONLY a valid JSON object, nothing else: {"handler":"...","params":{...}}`;
}

function extractJsonFromAiOutput(raw: string): unknown | null {
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed);
	} catch { /* */ }

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		try { return JSON.parse(fenced[1].trim()); } catch { /* */ }
	}

	const firstBrace = trimmed.indexOf('{');
	const lastBrace = trimmed.lastIndexOf('}');
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch { /* */ }
	}

	return null;
}

async function aiParseCommand(transcript: string, state: VoiceState): Promise<AiParsedCommand | null> {
	const agent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();
	const prompt = buildAiPrompt(transcript, state);

	try {
		let stdout: string;
		if (agent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '-p', prompt], {
				maxBuffer: 10 * 1024 * 1024,
				timeout: 30000,
			}));
		} else {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], {
				maxBuffer: 10 * 1024 * 1024,
				timeout: 30000,
			}));
		}

		const parsed = extractJsonFromAiOutput(stdout);
		if (!parsed || typeof parsed !== 'object') return null;

		const obj = parsed as Record<string, unknown>;
		const handler = typeof obj.handler === 'string' ? obj.handler : '';
		if (!handler || !COMMAND_HANDLERS[handler]) return null;

		const params: Record<string, string> = {};
		if (obj.params && typeof obj.params === 'object') {
			for (const [k, v] of Object.entries(obj.params as Record<string, unknown>)) {
				if (v !== undefined && v !== null && v !== '') {
					params[k] = String(v);
				}
			}
		}

		return { handler, params };
	} catch {
		return null;
	}
}

function startRecording(state: VoiceState): void {
	killTts();
	const rawFile = path.join(os.tmpdir(), `forgepilot-voice-${Date.now()}-raw.wav`);
	state.tempFile = rawFile;
	const proc = spawn('rec', [rawFile, 'rate', '16000', 'channels', '1'], {
		stdio: ['ignore', 'ignore', 'ignore'],
	});
	state.recProcess = proc;
	state.recording = true;
	state.recordingStartedAt = Date.now();
}

async function stopRecordingAndTranscribe(state: VoiceState): Promise<string | null> {
	if (!state.recProcess) {
		state.recording = false;
		return null;
	}

	const elapsed = Date.now() - state.recordingStartedAt;
	if (elapsed < MIN_RECORDING_MS) {
		await new Promise((r) => setTimeout(r, MIN_RECORDING_MS - elapsed));
	}

	const proc = state.recProcess;
	const rawFile = state.tempFile;
	state.recProcess = null;
	state.recording = false;

	await new Promise<void>((resolve) => {
		proc.on('close', () => resolve());
		try {
			proc.kill('SIGTERM');
		} catch {
			resolve();
			return;
		}
		setTimeout(resolve, 3000);
	});

	const pcmFile = rawFile.replace('-raw.wav', '.wav');

	try {
		if (!existsSync(rawFile)) {
			console.error(chalk.red('  Recording file not created. Check microphone permissions for Terminal.'));
			return null;
		}
		const rawSize = statSync(rawFile).size;
		if (rawSize < 1000) {
			console.error(chalk.yellow(`  Recording too short (${rawSize} bytes). Speak longer next time.`));
			return null;
		}

		execSync(`sox "${rawFile}" -r 16000 -c 1 -b 16 "${pcmFile}" 2>/dev/null`, { timeout: 10000 });

		if (!existsSync(pcmFile)) {
			console.error(chalk.red('  WAV conversion failed.'));
			return null;
		}
		const fileSize = statSync(pcmFile).size;
		console.log(chalk.gray(`  Recorded ${(fileSize / 1024).toFixed(1)} KB of audio.`));

		const wave = getSherpaModule()!.readWave(pcmFile);
		const stream = getSherpaRecognizer()!.createStream();
		stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
		getSherpaRecognizer()!.decode(stream);
		const result = getSherpaRecognizer()!.getResult(stream);
		const text = (result?.text ?? '').trim();

		if (!text || text === '[BLANK_AUDIO]') return null;
		return text;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(chalk.red(`  Transcription failed: ${msg.slice(0, 200)}`));
		return null;
	} finally {
		try { unlinkSync(rawFile); } catch { /* */ }
		try { unlinkSync(pcmFile); } catch { /* */ }
	}
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

function displayTicketPage(state: VoiceState): void {
	const start = state.ticketListPage * PAGE_SIZE;
	const page = state.lastTicketList.slice(start, start + PAGE_SIZE);
	if (!page.length) {
		printAndSpeak('No more tickets to show.');
		return;
	}

	const total = state.lastTicketList.length;
	const pageNum = state.ticketListPage + 1;
	const totalPages = Math.ceil(total / PAGE_SIZE);

	console.log(chalk.bold(`\n  Tickets (page ${pageNum}/${totalPages}, ${total} total):\n`));
	for (let i = 0; i < page.length; i++) {
		const t = page[i];
		const num = start + i + 1;
		console.log(chalk.white(`    ${chalk.gray(`${num}.`)} ${chalk.bold(t.key)} ${t.title} ${chalk.gray(`[${t.status}]`)}`));
	}
	const remaining = total - (start + page.length);
	if (remaining > 0) {
		console.log(chalk.gray(`    ... ${remaining} more — say "show more" for next page`));
	}
	console.log();

	printAndSpeak(
		page.length === 1
			? `Showing ticket ${start + 1}: ${page[0].key}, ${page[0].title}`
			: `Showing tickets ${start + 1} to ${start + page.length} of ${total}.${remaining > 0 ? ' Say show more for the next page.' : ''}`,
	);
}

async function handleListTickets(params: Record<string, string>, state: VoiceState): Promise<void> {
	const jql = params.jql?.trim();

	let tickets;
	if (jql) {
		console.log(chalk.gray(`  JQL: ${jql}`));
		printAndSpeak('Searching Jira...');
		tickets = await fetchTicketsByJql(jql);
	} else {
		const scope = (params.scope as TicketScope) || 'current-sprint';
		const scopeLabel = scope === 'current-sprint' ? 'current sprint' : 'all assigned';
		printAndSpeak(`Fetching ${scopeLabel} tickets...`);
		tickets = await fetchTicketsByScope(scope);
	}

	if (!tickets.length) {
		printAndSpeak('No tickets found.');
		return;
	}

	state.lastTicketList = tickets.map((t) => ({ key: t.key, title: t.title, status: t.status }));
	state.ticketListPage = 0;
	state.lastTicketKey = tickets[0].key;

	displayTicketPage(state);
}

async function handleGetTicketDetails(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = resolveTicketKey(params, state);
	if (!key) {
		printAndSpeak('Which ticket? Say the ticket key next time.');
		return;
	}

	printAndSpeak(`Getting details for ${key}...`);
	const detail = await fetchIssueDetail(key);
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const url = getJiraBrowseUrl(detail);

	console.log(chalk.bold(`\n  ${key}: ${detail.fields.summary ?? '(no title)'}`));
	console.log(chalk.gray(`  Status: ${detail.fields.status?.name ?? 'Unknown'}`));
	console.log(chalk.gray(`  URL: ${url}`));
	if (description) {
		console.log(chalk.white(`\n  Description:\n    ${description.slice(0, 500).replace(/\n/g, '\n    ')}`));
	}
	if (ac) {
		console.log(chalk.white(`\n  Acceptance Criteria:\n    ${ac.slice(0, 300).replace(/\n/g, '\n    ')}`));
	}
	console.log();

	state.lastTicketKey = key;
	printAndSpeak(`Ticket ${key}: ${detail.fields.summary ?? 'no title'}. Status: ${detail.fields.status?.name ?? 'unknown'}.`);
}

async function resolveAgent(__state: VoiceState): Promise<ReturnType<typeof resolveAgentOptionById> | null> {
	const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
	if (defaultAgentId) {
		const opt = resolveAgentOptionById(defaultAgentId) ?? null;
		if (opt) {
			printAndSpeak(`Using default agent: ${opt.label}.`);
			return opt;
		}
	}

	const agents = await getAvailableAgentOptions();
	if (!agents.length) {
		printAndSpeak('No coding agents found on your system. Install at least one agent CLI.');
		return null;
	}

	const agentOptions: VoiceOption[] = agents.map((a) => ({ id: a.id, label: a.label }));
	const chosenId = await askVoice('Which agent should I use?', agentOptions);
	if (!chosenId) {
		printAndSpeak('No agent selected. Cancelled.');
		return null;
	}

	return resolveAgentOptionById(chosenId) ?? null;
}

async function handleStartTicket(params: Record<string, string>, state: VoiceState): Promise<void> {
	const multiKeys = params.ticket_keys?.split(',').filter(Boolean);

	if (multiKeys && multiKeys.length > 1) {
		printAndSpeak(`Starting work on ${multiKeys.length} tickets: ${multiKeys.join(', ')}. Fetching details...`);

		const details: Awaited<ReturnType<typeof fetchIssueDetail>>[] = [];
		for (const k of multiKeys) {
			try {
				details.push(await fetchIssueDetail(k));
			} catch {
				printAndSpeak(`Could not fetch ${k}, skipping.`);
			}
		}
		if (!details.length) {
			printAndSpeak('No valid tickets found.');
			return;
		}

		const agentOption = await resolveAgent(state);
		if (!agentOption) return;

		printAndSpeak(`Launching ${agentOption.label} for ${details.length} tickets in parallel. This may take a while.`);

		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		try {
			const statuses = await launchMultipleTickets(details, agentOption, (s) => {
				for (const st of s) {
					const icon = st.status === 'done' ? '✓' : st.status === 'failed' ? '✗' : '⟳';
					console.log(chalk.gray(`    ${icon} ${st.ticketKey}: ${st.status}`));
				}
			});
			const done = statuses.filter((s) => s.status === 'done').length;
			const failed = statuses.filter((s) => s.status === 'failed').length;
			printAndSpeak(`Finished. ${done} completed, ${failed} failed out of ${statuses.length} tickets.`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			printAndSpeak(`Multi-ticket run failed: ${msg.slice(0, 100)}`);
		} finally {
			if (process.stdin.isTTY) process.stdin.setRawMode(true);
		}
		return;
	}

	const key = resolveTicketKey(params, state);
	if (!key) {
		printAndSpeak('Which ticket? Say the ticket key.');
		return;
	}
	state.lastTicketKey = key;

	printAndSpeak(`Starting work on ${key}. Fetching ticket details...`);
	const detail = await fetchIssueDetail(key);

	let repoMap = await resolveRepoPathsAuto(detail);
	if (!repoMap.size && state.lastRepoPath) {
		repoMap = new Map([['current', state.lastRepoPath]]);
	}
	if (!repoMap.size) {
		printAndSpeak('No repositories found. Set a root directory via CLI first.');
		return;
	}

	const repoPaths = [...repoMap.values()];
	state.lastRepoPath = repoPaths[0];
	printAndSpeak(`Using repo ${path.basename(repoPaths[0])}.`);

	const agentOption = await resolveAgent(state);
	if (!agentOption) return;

	printAndSpeak(`Launching ${agentOption.label} for ${key}. This may take a while.`);

	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	try {
		await launchAgentForRepos(detail, agentOption, repoMap);
		printAndSpeak(`${agentOption.label} finished working on ${key}.`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		printAndSpeak(`Agent failed: ${msg.slice(0, 100)}`);
	} finally {
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
	}
}

async function handlePushAndCreatePR(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = resolveTicketKey(params, state);
	const repoPath = state.lastRepoPath;

	if (!key || !repoPath) {
		printAndSpeak('I need a ticket key and repo path. Use the CLI for push and PR creation.');
		return;
	}

	printAndSpeak(`Pushing branch and creating PR for ${key}...`);
	try {
		let jiraUrl = '';
		let ticketTitle = key;
		try {
			const detail = await fetchIssueDetail(key);
			jiraUrl = getJiraBrowseUrl(detail);
			ticketTitle = String(detail.fields.summary ?? key);
		} catch {
			// Non-critical
		}
		const url = await pushBranchAndCreateMR(repoPath, key, ticketTitle, jiraUrl);
		printAndSpeak(url ? `PR created: ${url}` : 'Branch pushed, but no PR URL returned.');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		printAndSpeak(`Failed to push: ${msg}`);
	}
}

async function handleCheckStatus(_params: Record<string, string>, state: VoiceState): Promise<void> {
	const repoPath = state.lastRepoPath;
	if (!repoPath) {
		printAndSpeak('No repository path set. Use the CLI first to select a repo.');
		return;
	}

	const branch = await gitExec(repoPath, ['branch', '--show-current']);
	const status = await gitExec(repoPath, ['status', '--porcelain']);
	const changes = status ? status.split('\n').filter(Boolean).length : 0;

	console.log(chalk.bold(`\n  Branch: ${branch}`));
	console.log(chalk.white(`  Uncommitted changes: ${changes}`));
	if (status) {
		console.log(chalk.gray(`  ${status.slice(0, 500)}`));
	}
	console.log();

	printAndSpeak(
		`On branch ${branch}. ${changes === 0 ? 'No uncommitted changes.' : `${changes} uncommitted change${changes > 1 ? 's' : ''}.`}`,
	);
}

async function handleShowTodoProgress(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = resolveTicketKey(params, state);
	const repoPath = state.lastRepoPath;

	if (!key || !repoPath) {
		printAndSpeak('I need a ticket key and repo path.');
		return;
	}

	const progress = await parseTodoProgress(repoPath, key);
	if (!progress) {
		printAndSpeak(`No todo file found for ${key}.`);
		return;
	}

	console.log(chalk.bold(`\n  Todo progress for ${key}:`));
	console.log(chalk.green(`    Completed: ${progress.completed}`));
	console.log(chalk.yellow(`    Pending: ${progress.pending.length}`));
	console.log(chalk.white(`    Total: ${progress.total}`));
	for (const item of progress.completedItems) {
		console.log(chalk.green(`    ✓ ${item}`));
	}
	for (const item of progress.pending) {
		console.log(chalk.yellow(`    ○ ${item}`));
	}
	console.log();

	printAndSpeak(`${progress.completed} of ${progress.total} done for ${key}. ${progress.pending.length} remaining.`);
}

async function handleCheckReviewComments(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = resolveTicketKey(params, state);
	const repoPath = state.lastRepoPath;

	if (!key || !repoPath) {
		printAndSpeak('I need a ticket key and repo path.');
		return;
	}

	printAndSpeak(`Checking review comments for ${key}...`);
	const pr = await findOpenPullRequest(repoPath, key);
	if (!pr) {
		printAndSpeak(`No open PR or MR found for ${key}.`);
		return;
	}

	const comments = await fetchUnresolvedReviewComments(repoPath, pr);
	if (!comments.length) {
		printAndSpeak(`PR found but no unresolved comments on ${key}.`);
		return;
	}

	console.log(chalk.bold(`\n  ${comments.length} unresolved review comment(s) on ${pr.url}:\n`));
	for (const c of comments) {
		console.log(chalk.white(`    ${chalk.bold(c.path)}:${c.line ?? '?'} — ${c.body.slice(0, 120)}`));
		console.log(chalk.gray(`      by ${c.author}`));
	}
	console.log();

	printAndSpeak(`Found ${comments.length} unresolved comment${comments.length > 1 ? 's' : ''} on ${key}.`);
}

async function handleTransitionTicket(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = resolveTicketKey(params, state);
	if (!key) {
		printAndSpeak('Which ticket? Say the ticket key.');
		return;
	}

	printAndSpeak(`Moving ${key} to In Progress...`);
	try {
		const detail = await fetchIssueDetail(key);
		await transitionIssueToInProgress(detail);
		printAndSpeak(`${key} is now In Progress.`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		printAndSpeak(`Failed to transition ${key}: ${msg}`);
	}
}

const STATUS_MAP: Record<string, string> = {
	todo: '"To Do"',
	'to do': '"To Do"',
	backlog: '"Backlog"',
	'in progress': '"In Progress"',
	progress: '"In Progress"',
	working: '"In Progress"',
	review: '"In Review"',
	'in review': '"In Review"',
	qa: '"QA"',
	testing: '"QA"',
	test: '"QA"',
	done: '"Done"',
	closed: '"Closed"',
	blocked: '"Blocked"',
	open: '"Open"',
	resolved: '"Resolved"',
	ready: '"Ready for Dev"',
};

function buildJqlFromNaturalLanguage(transcript: string): string {
	const lower = transcript.toLowerCase();

	for (const [keyword, jqlStatus] of Object.entries(STATUS_MAP)) {
		if (lower.includes(keyword)) {
			return `assignee = currentUser() AND status = ${jqlStatus} ORDER BY updated DESC`;
		}
	}

	if (lower.includes('unassigned')) {
		return `assignee is EMPTY AND project in projectsWhereUserHasRole("Developers") ORDER BY created DESC`;
	}
	if (lower.includes('recent') || lower.includes('latest') || lower.includes('updated')) {
		return `assignee = currentUser() ORDER BY updated DESC`;
	}
	if (lower.includes('high priority') || lower.includes('urgent') || lower.includes('critical')) {
		return `assignee = currentUser() AND priority in (Highest, High, Critical) ORDER BY priority DESC`;
	}

	const words = lower.replace(/[^\w\s]/g, '').split(/\s+/).filter((w) => w.length > 2);
	const textQuery = words.join(' ');
	return `assignee = currentUser() AND text ~ "${textQuery}" ORDER BY updated DESC`;
}

async function handleSearchTickets(params: Record<string, string>, state: VoiceState): Promise<void> {
	const jql = params.jql?.trim() || (params.query ? buildJqlFromNaturalLanguage(params.query) : '');
	if (!jql) {
		printAndSpeak('What should I search for? Try saying "search tickets in QA" or "find blocked tickets".');
		return;
	}

	console.log(chalk.gray(`  JQL: ${jql}`));
	printAndSpeak('Searching Jira...');

	try {
		const tickets = await fetchTicketsByJql(jql);
		if (!tickets.length) {
			printAndSpeak('No tickets found for that search.');
			return;
		}

		state.lastTicketList = tickets.map((t) => ({ key: t.key, title: t.title, status: t.status }));
		state.ticketListPage = 0;
		state.lastTicketKey = tickets[0].key;

		displayTicketPage(state);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		printAndSpeak(`Search failed: ${msg.slice(0, 100)}`);
	}
}

async function handleCommitChanges(params: Record<string, string>, state: VoiceState): Promise<void> {
	const repoPath = state.lastRepoPath;
	if (!repoPath) {
		printAndSpeak('No repository path set.');
		return;
	}

	const status = await gitExec(repoPath, ['status', '--porcelain']);
	if (!status) {
		printAndSpeak('No changes to commit.');
		return;
	}

	const key = resolveTicketKey(params, state) || '';
	const defaultMsg = key ? `${key}: work in progress` : 'work in progress';

	const spokenMsg = await askVoice(`What should the commit message be? Default is "${defaultMsg}".`);
	const commitMsg = spokenMsg || defaultMsg;

	printAndSpeak(`Committing with message: ${commitMsg}`);
	try {
		await gitExec(repoPath, ['add', '-A']);
		await gitExec(repoPath, ['commit', '-m', commitMsg]);
		printAndSpeak('Changes committed successfully.');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		printAndSpeak(`Commit failed: ${msg.slice(0, 100)}`);
	}
}

async function handlePrepareBranch(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = resolveTicketKey(params, state);
	if (!key) {
		printAndSpeak('Which ticket? Say the ticket key.');
		return;
	}

	const repoPath = state.lastRepoPath;
	if (!repoPath) {
		printAndSpeak('No repository path set.');
		return;
	}

	printAndSpeak(`Preparing branch for ${key} in ${path.basename(repoPath)}...`);
	try {
		const effectivePath = await prepareRepoForWork(repoPath, key);
		state.lastRepoPath = effectivePath;
		const branch = await gitExec(effectivePath, ['branch', '--show-current']);
		printAndSpeak(`Branch ready: ${branch}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		printAndSpeak(`Failed to prepare branch: ${msg.slice(0, 100)}`);
	}
}

function handleShowMore(_params: Record<string, string>, state: VoiceState): void {
	if (!state.lastTicketList.length) {
		printAndSpeak('No ticket list to page through. Fetch tickets first.');
		return;
	}

	const maxPage = Math.ceil(state.lastTicketList.length / PAGE_SIZE) - 1;
	if (state.ticketListPage >= maxPage) {
		printAndSpeak('You are already on the last page.');
		return;
	}

	state.ticketListPage++;
	displayTicketPage(state);
}

async function handleCustomTask(params: Record<string, string>, state: VoiceState): Promise<void> {
	let description = params.description?.trim();

	if (!description) {
		printAndSpeak('What would you like to work on? Describe the task.');
		const spoken = await askVoice('Task description:');
		if (!spoken) {
			printAndSpeak('No description provided. Cancelled.');
			return;
		}
		description = spoken;
	}

	printAndSpeak(`Got it: "${description}". Let me find your repos.`);

	const rootDir = await getCached<string>('rootDir') ?? process.env.FORGEPILOT_ROOT_DIR?.trim();
	if (!rootDir) {
		printAndSpeak('No root directory set. Please set FORGEPILOT_ROOT_DIR or run the CLI to configure it.');
		return;
	}
	const resolvedRoot = rootDir.replace(/^~/, process.env.HOME ?? '~');

	const localRepos = await scanLocalRepos(resolvedRoot);
	if (!localRepos.length) {
		printAndSpeak('No repositories found in your root directory.');
		return;
	}

	const repoOptions: VoiceOption[] = localRepos.map((r) => ({
		id: r,
		label: path.basename(r),
	}));

	const selectedRepos: string[] = [];
	printAndSpeak('Which repository should I use? You can add more after.');

	while (true) {
		const remaining = repoOptions.filter((r) => !selectedRepos.includes(r.id));
		if (!remaining.length) break;

		const chosen = await askVoice(
			selectedRepos.length ? 'Add another repo? Say the name or say "done".' : 'Select a repo:',
			[...remaining, { id: '__done__', label: 'done' }],
		);
		if (!chosen || chosen === '__done__') break;
		selectedRepos.push(chosen);
		printAndSpeak(`Added ${path.basename(chosen)}.`);
	}

	if (!selectedRepos.length) {
		printAndSpeak('No repos selected. Cancelled.');
		return;
	}

	state.lastRepoPath = selectedRepos[0];
	const repoMap = new Map(selectedRepos.map((r) => [path.basename(r), r]));

	const agentOption = await resolveAgent(state);
	if (!agentOption) return;

	const branchSlug = description
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 50);
	const branchName = `custom/${branchSlug}`;

	const createTicketOptions: VoiceOption[] = [
		{ id: 'yes', label: 'yes' },
		{ id: 'no', label: 'no' },
	];
	const wantTicket = await askVoice('Would you like to create a Jira ticket for this task?', createTicketOptions);

	if (wantTicket === 'yes') {
		const projectKey = process.env.FORGEPILOT_JIRA_PROJECT_KEY?.trim();
		if (!projectKey) {
			printAndSpeak('FORGEPILOT_JIRA_PROJECT_KEY is not set. Skipping Jira ticket creation.');
		} else {
			try {
				printAndSpeak('Creating a Jira ticket...');
				const detail = await createJiraIssue(projectKey, description, description);
				printAndSpeak(`Created ${detail.key}. Now launching the agent.`);
				state.lastTicketKey = detail.key;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				printAndSpeak(`Could not create ticket: ${msg.slice(0, 80)}. Continuing without one.`);
			}
		}
	}

	printAndSpeak(`Launching ${agentOption.label} for custom task. This may take a while.`);

	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	try {
		await launchAgentForCustomTask(description, branchName, agentOption, repoMap);
		printAndSpeak(`${agentOption.label} finished the custom task.`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		printAndSpeak(`Agent failed: ${msg.slice(0, 100)}`);
	} finally {
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
	}
}

function handleShowHelp(): void {
	console.log(chalk.bold('\n  Available voice commands:\n'));
	for (const cmd of VOICE_COMMANDS) {
		if (cmd.id === 'stop') continue;
		const example = cmd.phrases[0];
		console.log(chalk.white(`    "${example}" — ${cmd.description}`));
	}
	console.log(chalk.white(`    "stop" / "goodbye" — Exit voice mode`));
	console.log();
	printAndSpeak('I listed all available commands on screen.');
}

const COMMAND_HANDLERS: Record<string, (params: Record<string, string>, state: VoiceState) => Promise<void> | void> = {
	listTickets: handleListTickets,
	getTicketDetails: handleGetTicketDetails,
	startTicket: handleStartTicket,
	pushAndCreatePR: handlePushAndCreatePR,
	checkStatus: handleCheckStatus,
	showTodoProgress: handleShowTodoProgress,
	checkReviewComments: handleCheckReviewComments,
	transitionTicket: handleTransitionTicket,
	searchTickets: handleSearchTickets,
	commitChanges: handleCommitChanges,
	prepareBranch: handlePrepareBranch,
	customTask: handleCustomTask,
	showMore: handleShowMore,
	showHelp: handleShowHelp,
	stopVoice: () => {},
};

async function executeCommand(match: MatchedCommand, state: VoiceState): Promise<void> {
	if (match.command.handler === 'stopVoice') {
		printAndSpeak('Goodbye!');
		state.shouldExit = true;
		return;
	}

	const handler = COMMAND_HANDLERS[match.command.handler];
	if (!handler) {
		printAndSpeak(`Command "${match.command.id}" is not implemented yet.`);
		return;
	}

	try {
		await handler(match.params, state);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(chalk.red(`  Error: ${msg}`));
		printAndSpeak(`Something went wrong: ${msg.slice(0, 100)}`);
	}
}

// ---------------------------------------------------------------------------
// Push-to-Talk Loop
// ---------------------------------------------------------------------------

function waitForKey(accept: string[]): Promise<string> {
	return new Promise((resolve) => {
		const onKeypress = (_: unknown, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				cleanup();
				resolve('quit');
				return;
			}
			const name = key.name ?? '';
			if (accept.includes(name)) {
				cleanup();
				resolve(name);
			}
		};

		const cleanup = () => {
			process.stdin.removeListener('keypress', onKeypress);
		};

		process.stdin.on('keypress', onKeypress);
	});
}

function drainKeypresses(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const noop = () => {};
		process.stdin.on('keypress', noop);
		setTimeout(() => {
			process.stdin.removeListener('keypress', noop);
			resolve();
		}, ms);
	});
}

async function loadLastContext(state: VoiceState): Promise<void> {
	try {
		const lastTicket = await getCached<string>('lastTicketKey');
		if (lastTicket) {
			state.lastTicketKey = lastTicket;
			const repoPaths = await getCached<string[]>(`repoChoice_${lastTicket}`);
			if (repoPaths?.length && existsSync(path.join(repoPaths[0], '.git'))) {
				state.lastRepoPath = repoPaths[0];
				return;
			}
		}
		const rootDir = await getCached<string>('rootDir');
		if (rootDir) state.lastRepoPath = rootDir;
	} catch {
		// No cached context
	}
}

export async function startVoiceMode(): Promise<void> {
	const missing = checkVoiceDependencies();
	if (missing) {
		const modelDir = getSherpaModelDir();
		console.error(chalk.red(`\n  "${missing}" is required for voice mode but was not found.`));
		console.error(chalk.yellow('  Install:'));
		console.error(chalk.white('    npm install sherpa-onnx-node'));
		console.error(chalk.white('    brew install sox'));
		console.error(chalk.yellow('  Download the Whisper model:'));
		console.error(chalk.white(`    mkdir -p ${modelDir}`));
		console.error(chalk.white(`    cd ${modelDir}`));
		console.error(chalk.white('    curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-encoder.int8.onnx'));
		console.error(chalk.white('    curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-decoder.int8.onnx'));
		console.error(chalk.white('    curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-tokens.txt'));
		process.exit(1);
	}

	console.log(chalk.gray('  Loading speech recognition model...'));
	initRecognizer();
	setVoiceModeActive(true);

	const state: VoiceState = {
		recProcess: null,
		lastTicketKey: null,
		lastRepoPath: null,
		lastTicketList: [],
		ticketListPage: 0,
		shouldExit: false,
		recording: false,
		recordingStartedAt: 0,
		tempFile: '',
	};

	await loadLastContext(state);

	readline.emitKeypressEvents(process.stdin);
	if (process.stdin.isTTY) process.stdin.setRawMode(true);

	console.log(chalk.bold('\n  ╔══════════════════════════════════════════════╗'));
	console.log(chalk.bold('  ║         ForgePilot Voice Mode Active         ║'));
	console.log(chalk.bold('  ╠══════════════════════════════════════════════╣'));
	console.log(chalk.white('  ║  Press [Space] to start/stop recording       ║'));
	console.log(chalk.white('  ║  Press [q] or Ctrl+C to exit                 ║'));
	console.log(chalk.bold('  ╚══════════════════════════════════════════════╝\n'));

	speak('Voice mode active. Press space to talk.');

	process.on('SIGINT', () => {
		if (state.recProcess) {
			try { state.recProcess.kill(); } catch { /* */ }
		}
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.exit(0);
	});

	while (!state.shouldExit) {
		console.log(chalk.gray('  Press [Space] to start recording...'));

		const startKey = await waitForKey(['space', 'q']);
		if (startKey === 'quit' || startKey === 'q') {
			state.shouldExit = true;
			break;
		}

		console.log(chalk.green('  🎙  Recording... press [Space] to stop'));
		startRecording(state);

		await drainKeypresses(KEY_DEBOUNCE_MS);

		const stopKey = await waitForKey(['space']);
		if (stopKey === 'quit') {
			if (state.recProcess) {
				try { state.recProcess.kill(); } catch { /* */ }
			}
			state.shouldExit = true;
			break;
		}

		console.log(chalk.gray('  Transcribing...'));
		const transcript = await stopRecordingAndTranscribe(state);

		if (!transcript) {
			continue;
		}

		console.log(chalk.bold(`  You said: "${transcript}"`));

		console.log(chalk.gray('  Thinking...'));
		const aiResult = await aiParseCommand(transcript, state);

		if (aiResult) {
			console.log(chalk.green(`  → ${aiResult.handler} (AI)`));
			if (aiResult.handler === 'stopVoice') {
				printAndSpeak('Goodbye!');
				state.shouldExit = true;
				break;
			}
			const handler = COMMAND_HANDLERS[aiResult.handler];
			if (handler) {
				try {
					await handler(aiResult.params, state);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(chalk.red(`  Error: ${msg}`));
					printAndSpeak(`Something went wrong: ${msg.slice(0, 100)}`);
				}
			}
			continue;
		}

		console.log(chalk.gray('  AI unavailable, using keyword matching...'));
		const match = matchCommand(transcript);

		if (!match) {
			printAndSpeak(`I didn't understand "${transcript}". Say "help" for commands.`);
			continue;
		}

		if (match.confidence < 0.5) {
			printAndSpeak(`Did you mean "${match.command.phrases[0]}"? Try again more clearly.`);
			continue;
		}

		console.log(chalk.green(`  → ${match.command.id} (${(match.confidence * 100).toFixed(0)}% match)`));
		await executeCommand(match, state);
	}

	setVoiceModeActive(false);
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	printAndSpeak('Goodbye!');
	console.log(chalk.gray('  Voice mode ended.'));
}
