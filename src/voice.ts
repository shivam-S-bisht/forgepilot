import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { unlinkSync, existsSync, statSync } from 'node:fs';
import chalk from 'chalk';

const esmRequire = createRequire(import.meta.url);
import { matchCommand, VOICE_COMMANDS, type MatchedCommand } from './voice-commands.js';
import { fetchTicketsByScope } from './jira.js';
import type { TicketScope } from './jira.js';
import { fetchIssueDetail, transitionIssueToInProgress } from './jira.js';
import { getDescriptionText, getAcceptanceCriteria, getJiraBrowseUrl } from './jira-text.js';
import { gitExec, findOpenPullRequest, fetchUnresolvedReviewComments, pushBranchAndCreateMR } from './git.js';
import { parseTodoProgress } from './agents.js';
import { getCached } from './cache.js';

type VoiceState = {
	recProcess: ChildProcess | null;
	lastTicketKey: string | null;
	lastRepoPath: string | null;
	shouldExit: boolean;
	recording: boolean;
	recordingStartedAt: number;
	tempFile: string;
};

const SHERPA_MODEL_DIR = path.join(os.homedir(), '.forgepilot', 'sherpa-models', 'whisper-tiny.en');
const MIN_RECORDING_MS = 1000;
const KEY_DEBOUNCE_MS = 500;

let sherpaRecognizer: any = null;
let sherpaModule: any = null;

function getTtsCommand(): string {
	return process.env.FORGEPILOT_VOICE_TTS?.trim() || 'say';
}

function checkDependencies(): string | null {
	try {
		esmRequire.resolve('sherpa-onnx-node');
	} catch {
		return 'sherpa-onnx-node (npm install sherpa-onnx-node)';
	}
	const encoder = path.join(SHERPA_MODEL_DIR, 'tiny.en-encoder.int8.onnx');
	if (!existsSync(encoder)) {
		return `whisper model files in ${SHERPA_MODEL_DIR}`;
	}
	try {
		execFileSync('which', ['rec'], { stdio: 'pipe' });
	} catch {
		return 'sox (rec)';
	}
	return null;
}

function initRecognizer(): void {
	if (sherpaRecognizer) return;
	sherpaModule = esmRequire('sherpa-onnx-node');
	sherpaRecognizer = new sherpaModule.OfflineRecognizer({
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			whisper: {
				encoder: path.join(SHERPA_MODEL_DIR, 'tiny.en-encoder.int8.onnx'),
				decoder: path.join(SHERPA_MODEL_DIR, 'tiny.en-decoder.int8.onnx'),
			},
			tokens: path.join(SHERPA_MODEL_DIR, 'tiny.en-tokens.txt'),
			numThreads: 2,
			provider: 'cpu',
		},
	});
}

let activeTtsProcess: ChildProcess | null = null;

function speak(text: string): void {
	const tts = getTtsCommand();
	try {
		if (activeTtsProcess) {
			try { activeTtsProcess.kill(); } catch { /* */ }
		}
		const sanitized = text.replace(/["`$]/g, '').slice(0, 200);
		activeTtsProcess = spawn(tts, [sanitized], { stdio: 'ignore' });
		activeTtsProcess.on('close', () => { activeTtsProcess = null; });
	} catch {
		// TTS not available
	}
}

function printAndSpeak(text: string): void {
	console.log(chalk.cyan(`  🔊 ${text}`));
	speak(text);
}

function killTts(): void {
	if (activeTtsProcess) {
		try { activeTtsProcess.kill(); } catch { /* */ }
		activeTtsProcess = null;
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

		const wave = sherpaModule.readWave(pcmFile);
		const stream = sherpaRecognizer.createStream();
		stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
		sherpaRecognizer.decode(stream);
		const result = sherpaRecognizer.getResult(stream);
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

async function handleListTickets(params: Record<string, string>, state: VoiceState): Promise<void> {
	const scope = (params.scope as TicketScope) || 'current-sprint';
	const scopeLabel = scope === 'current-sprint' ? 'current sprint' : 'all assigned';
	printAndSpeak(`Fetching ${scopeLabel} tickets...`);

	const tickets = await fetchTicketsByScope(scope);
	if (!tickets.length) {
		printAndSpeak('No tickets found.');
		return;
	}

	console.log(chalk.bold(`\n  Found ${tickets.length} ticket(s):\n`));
	for (const t of tickets.slice(0, 10)) {
		console.log(chalk.white(`    ${chalk.bold(t.key)} ${t.title} ${chalk.gray(`[${t.status}]`)}`));
	}
	if (tickets.length > 10) {
		console.log(chalk.gray(`    ... and ${tickets.length - 10} more`));
	}
	console.log();

	const summary =
		tickets.length === 1
			? `You have 1 ticket: ${tickets[0].key}, ${tickets[0].title}`
			: `You have ${tickets.length} tickets. The first one is ${tickets[0].key}, ${tickets[0].title}`;
	printAndSpeak(summary);
	state.lastTicketKey = tickets[0].key;
}

async function handleGetTicketDetails(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = params.ticket_key || state.lastTicketKey;
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

async function handleStartTicket(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = params.ticket_key || state.lastTicketKey;
	if (!key) {
		printAndSpeak('Which ticket? Say the ticket key.');
		return;
	}

	printAndSpeak(`To start working on ${key}, use the CLI. Voice mode supports read-only operations for now.`);
	state.lastTicketKey = key;
}

async function handlePushAndCreatePR(params: Record<string, string>, state: VoiceState): Promise<void> {
	const key = params.ticket_key || state.lastTicketKey;
	const repoPath = state.lastRepoPath;

	if (!key || !repoPath) {
		printAndSpeak('I need a ticket key and repo path. Use the CLI for push and PR creation.');
		return;
	}

	printAndSpeak(`Pushing branch and creating PR for ${key}...`);
	try {
		let jiraUrl = '';
		try {
			const detail = await fetchIssueDetail(key);
			jiraUrl = getJiraBrowseUrl(detail);
		} catch {
			// Non-critical
		}
		const url = await pushBranchAndCreateMR(repoPath, key, key, jiraUrl);
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
	const key = params.ticket_key || state.lastTicketKey;
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
	const key = params.ticket_key || state.lastTicketKey;
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
	const key = params.ticket_key || state.lastTicketKey;
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

function handleSearchTickets(): void {
	printAndSpeak('Free-form Jira search is not supported by voice yet. Use the CLI with a JQL query.');
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
		const rootDir = await getCached<string>('rootDir');
		if (rootDir) state.lastRepoPath = rootDir;
	} catch {
		// No cached context
	}
}

export async function startVoiceMode(): Promise<void> {
	const missing = checkDependencies();
	if (missing) {
		console.error(chalk.red(`\n  "${missing}" is required for voice mode but was not found.`));
		console.error(chalk.yellow('  Install:'));
		console.error(chalk.white('    npm install sherpa-onnx-node'));
		console.error(chalk.white('    brew install sox'));
		console.error(chalk.yellow('  Download the Whisper model:'));
		console.error(chalk.white(`    mkdir -p ${SHERPA_MODEL_DIR}`));
		console.error(chalk.white(`    cd ${SHERPA_MODEL_DIR}`));
		console.error(chalk.white('    curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-encoder.int8.onnx'));
		console.error(chalk.white('    curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-decoder.int8.onnx'));
		console.error(chalk.white('    curl -LO https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main/tiny.en-tokens.txt'));
		process.exit(1);
	}

	console.log(chalk.gray('  Loading speech recognition model...'));
	initRecognizer();

	const state: VoiceState = {
		recProcess: null,
		lastTicketKey: null,
		lastRepoPath: null,
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

	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	printAndSpeak('Goodbye!');
	console.log(chalk.gray('  Voice mode ended.'));
}
