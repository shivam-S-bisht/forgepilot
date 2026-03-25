import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { open as fsOpen } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getAxonPromptHint, logAxonStatus, startAxonWatch, stopAxonWatch } from '../tools/axon/axon.js';
import { clearCached, getCached, setCached } from './cache.js';
import { fetchFigmaDesignContext } from '../tools/figma/figma.js';
import { extractBaseBranchOverride, fetchUnresolvedReviewComments, findOpenPullRequest, prepareRepoForWork, readContributing, removeWorktree } from '../tools/git/git.js';
import type { OpenPR, ReviewComment } from '../tools/git/git.js';
import { transitionIssueToInProgress } from '../tools/jira/jira.js';
import { buildWorkPrompt, buildCustomTaskPrompt, buildSubTaskPrompt, getJiraBrowseUrl, getDescriptionText, getAcceptanceCriteria, commentsText } from '../tools/jira/jira-text.js';
import type { ReviewCommentForPrompt } from '../tools/jira/jira-text.js';
import { formatClarifications, runPreflightChecks } from './preflight.js';
import { resolveRepoPathsForMultipleTickets } from './repo.js';
import { isSlackFullFlowEnabled, notifySlackStatus } from '../tools/slack/slack.js';
import type { JiraIssueDetail, TicketRunStatus, WorkAgentOption } from './types.js';
import { ensureLogDirs, getLogFilePath, registerJob, updateJob } from './job-manager.js';
import type { JobRecord } from './job-manager.js';
import { askUser, askUserChoice } from './ask.js';
import { isVoiceModeActive, printAndSpeak } from '../tools/voice/voice-input.js';
import {
	isOllamaInstalled,
	ensureOllamaServing,
	listOllamaModels,
	pullOllamaModel,
	getOllamaApiBase,
	getConfiguredModel,
	getRecommendedModel,
} from '../tools/ollama/ollama.js';

const execFileAsync = promisify(execFile);

type MultiRepoBranchStrategy = 'same-branch' | 'separate-branches';

async function promptMultiRepoBranchStrategy(repoPaths: string[], branchHint: string): Promise<MultiRepoBranchStrategy> {
	if (repoPaths.length <= 1) return 'same-branch';

	const repoNames = repoPaths.map((p) => path.basename(p));
	console.log(chalk.cyan(`\n  Working across ${repoPaths.length} repos: ${repoNames.join(', ')}`));

	if (isVoiceModeActive()) {
		printAndSpeak(`You're working on ${repoPaths.length} repositories. Same branch name across all and push separately?`);
	}

	const choice = await askUserChoice(
		`Branch strategy for ${repoPaths.length} repos:`,
		[
			{ id: 'same-branch', label: `Same branch "${branchHint}" across all repos, push each separately` },
			{ id: 'separate-branches', label: 'Let each repo decide its own branch independently' },
		],
	);

	if (choice === 'separate-branches') {
		console.log(chalk.gray('  Each repo will manage its own branch.'));
		return 'separate-branches';
	}

	console.log(chalk.green(`  ✓ Using branch "${branchHint}" across all repos. Each repo will be pushed separately.`));
	return 'same-branch';
}

// ---------------------------------------------------------------------------
// Checkpoint types and helpers
// ---------------------------------------------------------------------------

type CheckpointState = {
	ticketKey: string;
	agentId: string;
	agentLabel: string;
	repoPath: string;
	effectivePath: string;
	startedAt: string;
	lastUpdatedAt: string;
};

export type TodoProgress = {
	total: number;
	completed: number;
	pending: string[];
	completedItems: string[];
};

function todoFilePath(repoPath: string, ticketKey: string): string {
	const safeKey = ticketKey.toUpperCase().replace(/[/\\]/g, '-');
	return path.join(repoPath, `.forgepilot-todos-${safeKey}.md`);
}

function checkpointCacheKey(ticketKey: string): string {
	return `checkpoint-${ticketKey.toUpperCase()}`;
}

async function saveCheckpoint(ticketKey: string, state: CheckpointState): Promise<void> {
	await setCached(checkpointCacheKey(ticketKey), state);
}

async function loadCheckpoint(ticketKey: string): Promise<CheckpointState | null> {
	return getCached<CheckpointState>(checkpointCacheKey(ticketKey));
}

async function clearCheckpoint(ticketKey: string): Promise<void> {
	await clearCached(checkpointCacheKey(ticketKey));
}

export async function parseTodoProgress(repoPath: string, ticketKey: string): Promise<TodoProgress | null> {
	const filePath = todoFilePath(repoPath, ticketKey);
	if (!existsSync(filePath)) return null;
	try {
		const content = await fs.readFile(filePath, 'utf8');
		const lines = content.split('\n');
		const completed: string[] = [];
		const pending: string[] = [];

		for (const line of lines) {
			const checkedMatch = line.match(/^-\s*\[x\]\s+(.+)/i);
			const uncheckedMatch = line.match(/^-\s*\[\s\]\s+(.+)/);
			if (checkedMatch) completed.push(checkedMatch[1].trim());
			else if (uncheckedMatch) pending.push(uncheckedMatch[1].trim());
		}

		const total = completed.length + pending.length;
		if (total === 0) return null;
		return { total, completed: completed.length, pending, completedItems: completed };
	} catch {
		return null;
	}
}

type ResumeChoice = 'resume' | 'fresh' | 're-analyze' | 'show-progress';

async function promptForResume(
	ticketKey: string,
	progress: TodoProgress,
	checkpoint: CheckpointState | null,
): Promise<ResumeChoice> {
	const header = `Checkpoint found for *${ticketKey}*: ${progress.completed}/${progress.total} tasks completed.`;
	const agentInfo = checkpoint ? ` Last agent: ${checkpoint.agentLabel} (${new Date(checkpoint.lastUpdatedAt).toLocaleString()}).` : '';

	const options: { id: ResumeChoice; label: string }[] = [
		{ id: 'resume', label: 'Resume from checkpoint — continue where the agent left off' },
		{ id: 'fresh', label: 'Start fresh — discard progress and start over' },
		{ id: 're-analyze', label: 'Re-analyze ticket — discard todos, let agent re-plan from scratch' },
		{ id: 'show-progress', label: 'Show current progress — view completed/pending items, then decide' },
	];

	const selected = await askUserChoice(`${header}${agentInfo}`, options);
	return (selected as ResumeChoice) || 'resume';
}

function displayTodoProgress(ticketKey: string, progress: TodoProgress): void {
	console.log(chalk.bold(`\n  Todo progress for ${ticketKey} (${progress.completed}/${progress.total}):\n`));
	for (const item of progress.completedItems) {
		console.log(chalk.green(`    [x] ${item}`));
	}
	for (const item of progress.pending) {
		console.log(chalk.yellow(`    [ ] ${item}`));
	}
	console.log('');
}

async function handleCheckpointResume(
	effectivePath: string,
	ticketKey: string,
): Promise<{ resumeMode: boolean }> {
	const progress = await parseTodoProgress(effectivePath, ticketKey);
	if (!progress) return { resumeMode: false };

	const checkpoint = await loadCheckpoint(ticketKey);
	let choice = await promptForResume(ticketKey, progress, checkpoint);

	if (choice === 'show-progress') {
		displayTodoProgress(ticketKey, progress);
		if (isSlackFullFlowEnabled()) {
			const progressLines = [
				`:clipboard: *Todo progress for ${ticketKey}* (${progress.completed}/${progress.total}):`,
				'',
				...progress.completedItems.map((item) => `:white_check_mark: ~${item}~`),
				...progress.pending.map((item) => `:black_square_button: ${item}`),
			].join('\n');
			await notifySlackStatus(progressLines);
		}
		choice = await promptForResume(ticketKey, progress, checkpoint);
	}

	if (choice === 'resume') {
		console.log(chalk.green(`  Resuming from checkpoint (${progress.completed}/${progress.total} done).`));
		await notifySlackStatus(`Resuming ${ticketKey} from checkpoint: ${progress.completed}/${progress.total} tasks already completed.`);
		return { resumeMode: true };
	}

	console.log(chalk.gray(`  Discarding checkpoint for ${ticketKey}. Starting ${choice === 're-analyze' ? 'with re-analysis' : 'fresh'}...`));
	const todoFile = todoFilePath(effectivePath, ticketKey);
	try { await fs.unlink(todoFile); } catch { /* ignore */ }
	await clearCheckpoint(ticketKey);
	await notifySlackStatus(`Discarded checkpoint for ${ticketKey}. Starting ${choice === 're-analyze' ? 'with re-analysis' : 'fresh'}.`);
	return { resumeMode: false };
}

type ExistingPlanChoice = 'continue' | 'modify' | 'fresh';

async function handleExistingPlan(
	ticketKey: string,
	repoPaths: string[],
): Promise<{ choice: ExistingPlanChoice; progress: TodoProgress | null }> {
	for (const rp of repoPaths) {
		const progress = await parseTodoProgress(rp, ticketKey);
		if (!progress) continue;

		displayTodoProgress(ticketKey, progress);

		const checkpoint = await loadCheckpoint(ticketKey);
		const agentInfo = checkpoint
			? ` Last agent: ${checkpoint.agentLabel} (${new Date(checkpoint.lastUpdatedAt).toLocaleString()}).`
			: '';

		const choice = await askUserChoice(
			`Existing plan found for ${ticketKey} — ${progress.completed}/${progress.total} tasks done.${agentInfo} What would you like to do?`,
			[
				{ id: 'continue', label: 'Continue with this plan — resume where it left off' },
				{ id: 'modify', label: 'Modify the plan — tell me what to change' },
				{ id: 'fresh', label: 'Start fresh — discard this plan and generate a new one' },
			],
		);

		if (choice === 'modify' || choice === 'fresh') {
			for (const p of repoPaths) {
				const todoFile = todoFilePath(p, ticketKey);
				try { await fs.unlink(todoFile); } catch { /* ignore */ }
			}
			await clearCheckpoint(ticketKey);
		}

		return { choice: choice as ExistingPlanChoice, progress };
	}
	return { choice: 'fresh', progress: null };
}

// ---------------------------------------------------------------------------
// MR/PR review comment handling
// ---------------------------------------------------------------------------

async function writeTodosFromReviewComments(
	repoPath: string,
	ticketKey: string,
	title: string,
	comments: ReviewComment[],
): Promise<void> {
	const filePath = todoFilePath(repoPath, ticketKey);
	const lines = [
		`# ${ticketKey}: ${title} — Review Feedback`,
		'',
		...comments.map((c) => {
			const location = c.line ? `${c.path}:${c.line}` : c.path || 'general';
			return `- [ ] Address review: ${location} — "${c.body}" (@${c.author})`;
		}),
		'',
	];
	await fs.writeFile(filePath, lines.join('\n'), 'utf8');
}

type ReviewDetectionResult = {
	reviewMode: boolean;
	reviewComments: ReviewCommentForPrompt[];
};

async function handleReviewDetection(
	effectivePath: string,
	ticketKey: string,
	title: string,
): Promise<ReviewDetectionResult> {
	const noReview: ReviewDetectionResult = { reviewMode: false, reviewComments: [] };

	let pr: OpenPR | null = null;
	try {
		pr = await findOpenPullRequest(effectivePath, ticketKey);
	} catch {
		return noReview;
	}
	if (!pr) return noReview;

	console.log(chalk.gray(`  Found open ${pr.platform === 'github' ? 'PR' : 'MR'}: ${pr.url || `#${pr.number}`}`));

	let comments: ReviewComment[] = [];
	try {
		comments = await fetchUnresolvedReviewComments(effectivePath, pr);
	} catch {
		return noReview;
	}

	if (!comments.length) {
		console.log(chalk.gray('  No unresolved review comments found.'));
		return noReview;
	}

	console.log(chalk.yellow(`\n  Found ${comments.length} unresolved review comment(s) on ${pr.platform === 'github' ? 'PR' : 'MR'} #${pr.number}:`));
	for (const c of comments) {
		const location = c.line ? `${c.path}:${c.line}` : c.path || 'general';
		console.log(chalk.cyan(`    [${location}] @${c.author}: ${c.body.slice(0, 100)}${c.body.length > 100 ? '...' : ''}`));
	}
	console.log('');

	const options: { id: string; label: string }[] = [
		{ id: 'address', label: 'Address review comments — create todos from feedback' },
		{ id: 'ignore', label: 'Ignore — continue normally (checkpoint/fresh)' },
	];

	const choice = await askUserChoice(
		`Found ${comments.length} unresolved review comment(s) on ${pr.platform === 'github' ? 'PR' : 'MR'} #${pr.number} for *${ticketKey}*:`,
		options,
	);

	if (choice === 'ignore') {
		console.log(chalk.gray('  Ignoring review comments. Proceeding normally.'));
		return noReview;
	}

	console.log(chalk.green(`  Creating todos from ${comments.length} review comment(s)...`));
	await writeTodosFromReviewComments(effectivePath, ticketKey, title, comments);
	await notifySlackStatus(`Addressing ${comments.length} review comment(s) on ${pr.platform === 'github' ? 'PR' : 'MR'} #${pr.number} for ${ticketKey}.`);

	const promptComments: ReviewCommentForPrompt[] = comments.map((c) => ({
		path: c.path,
		line: c.line,
		body: c.body,
		author: c.author,
	}));

	return { reviewMode: true, reviewComments: promptComments };
}

async function cleanupTodoFiles(repoPath: string): Promise<void> {
	try {
		const entries = await fs.readdir(repoPath);
		for (const entry of entries) {
			if (entry.startsWith('.forgepilot-todos-') && entry.endsWith('.md')) {
				await fs.unlink(path.join(repoPath, entry));
				console.log(chalk.gray(`  Cleaned up ${entry}`));
			}
		}
	} catch {
		// Non-critical — ignore cleanup failures.
	}
}

function questionsFilePath(repoPath: string, ticketKey: string): string {
	return path.join(repoPath, `.forgepilot-questions-${ticketKey.toUpperCase()}.md`);
}

function answersFilePath(repoPath: string, ticketKey: string): string {
	return path.join(repoPath, `.forgepilot-answers-${ticketKey.toUpperCase()}.md`);
}

async function readQuestionsFile(repoPath: string, ticketKey: string): Promise<string[] | null> {
	const filePath = questionsFilePath(repoPath, ticketKey);
	if (!existsSync(filePath)) return null;
	try {
		const content = await fs.readFile(filePath, 'utf8');
		const questions = content
			.split('\n')
			.map((line) => line.replace(/^-\s*/, '').trim())
			.filter(Boolean);
		return questions.length > 0 ? questions : null;
	} catch {
		return null;
	}
}

async function writeAnswersFile(
	repoPath: string,
	ticketKey: string,
	qaPairs: Array<{ question: string; answer: string }>,
): Promise<void> {
	const filePath = answersFilePath(repoPath, ticketKey);
	const lines = qaPairs.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`);
	await fs.writeFile(filePath, lines.join('\n\n') + '\n', 'utf8');
}

async function routeQuestions(
	questions: string[],
	ticketKey: string,
): Promise<Array<{ question: string; answer: string }>> {
	const results: Array<{ question: string; answer: string }> = [];

	console.log(chalk.bold.cyan(`\n  Agent has ${questions.length} question(s) for ${ticketKey}:\n`));

	for (let i = 0; i < questions.length; i++) {
		const question = questions[i];
		console.log(chalk.cyan(`  [${i + 1}/${questions.length}] ${question}`));

		let answer = await askUser(chalk.cyan('    Your answer (press Enter to skip): '));

		if (answer) {
			console.log(chalk.green(`    ✓ Noted.\n`));
		} else {
			answer = 'No answer provided — use your best judgment.';
			console.log(chalk.gray(`    ↳ Skipped.\n`));
		}

		results.push({ question, answer });
	}

	return results;
}

async function cleanupQuestionFiles(repoPath: string): Promise<void> {
	try {
		const entries = await fs.readdir(repoPath);
		for (const entry of entries) {
			if (
				(entry.startsWith('.forgepilot-questions-') || entry.startsWith('.forgepilot-answers-')) &&
				entry.endsWith('.md')
			) {
				await fs.unlink(path.join(repoPath, entry));
				console.log(chalk.gray(`  Cleaned up ${entry}`));
			}
		}
	} catch {
		// Non-critical.
	}
}

async function runCommandInteractive(command: string, args: string[], toolName: string, cwd?: string): Promise<void> {
	await runCommandInteractiveWithEnv(command, args, toolName, cwd);
}

async function runCommandInteractiveWithEnv(command: string, args: string[], toolName: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) });
		child.on('error', (error: NodeJS.ErrnoException) => {
			if (error?.code === 'ENOENT') {
				reject(new Error(`${toolName} CLI is not installed or not in PATH.`));
				return;
			}
			reject(error);
		});
		child.on('exit', (code) => {
			if (process.stdin.readable) {
				process.stdin.resume();
			}
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${toolName} CLI exited with code ${code ?? 'unknown'}`));
		});
	});
}

export async function runCommandBackground(
	command: string,
	args: string[],
	toolName: string,
	ticketKey: string,
	title: string,
	repos: string[],
	cwd?: string,
	agentOptionId?: string,
): Promise<JobRecord> {
	await ensureLogDirs();
	const logFile = getLogFilePath(ticketKey);
	const logFd = await fsOpen(logFile, 'w');

	const spawnEnv = agentOptionId === 'ollama-local'
		? { ...process.env, OLLAMA_API_BASE: getOllamaApiBase() }
		: undefined;

	const child = spawn(command, args, {
		stdio: ['ignore', logFd.fd, logFd.fd],
		detached: true,
		...(cwd ? { cwd } : {}),
		...(spawnEnv ? { env: spawnEnv } : {}),
	});
	child.unref();

	const job: JobRecord = {
		id: ticketKey,
		ticketKey,
		title,
		agent: toolName,
		agentOptionId,
		pid: child.pid!,
		logFile,
		status: 'running',
		startedAt: new Date().toISOString(),
		repos,
		effectivePaths: cwd ? [cwd] : [],
	};

	await registerJob(job);

	child.on('error', async () => {
		await logFd.close();
		await updateJob(ticketKey, {
			status: 'failed',
			error: `${toolName} CLI not found or failed to start`,
			finishedAt: new Date().toISOString(),
		});
	});

	child.on('exit', async (code) => {
		await logFd.close();
		await updateJob(ticketKey, {
			status: code === 0 ? 'done' : 'failed',
			error: code !== 0 ? `Exited with code ${code ?? 'unknown'}` : undefined,
			finishedAt: new Date().toISOString(),
		});
	});

	return job;
}

export function resolveAgentCommand(
	agentOption: WorkAgentOption,
	prompt: string,
	repoPath: string,
	jiraUrl: string,
	additionalDirs: string[] = [],
): { command: string; args: string[]; toolName: string } {
	const addDirArgs = (dirs: string[]) => dirs.flatMap((d) => ['--add-dir', d]);

	switch (agentOption.id) {
		case 'copilot-autonomous':
			return { command: 'copilot', args: ['-p', prompt, '--autopilot', '--allow-all-tools', '--allow-all-paths', '--add-dir', repoPath, ...addDirArgs(additionalDirs)], toolName: 'Copilot' };
		case 'copilot-interactive':
			return { command: 'copilot', args: ['-i', prompt, '--add-dir', repoPath, ...addDirArgs(additionalDirs)], toolName: 'Copilot' };
		case 'claude-code-autonomous':
			return { command: 'claude', args: ['-p', prompt, '--add-dir', repoPath, ...addDirArgs(additionalDirs)], toolName: 'Claude Code' };
		case 'claude-code-interactive':
			return { command: 'claude', args: [prompt, '--add-dir', repoPath, ...addDirArgs(additionalDirs)], toolName: 'Claude Code' };
		case 'cursor-autonomous':
			return { command: 'cursor', args: ['agent', '--yolo', '--workspace', repoPath, '-p', prompt], toolName: 'Cursor Agent' };
		case 'gemini-autonomous':
			return { command: 'gemini', args: ['-p', prompt], toolName: 'Gemini CLI' };
		case 'codex-full-auto':
			return { command: 'codex', args: ['--full-auto', prompt], toolName: 'Codex CLI' };
		case 'codex-autonomous':
			return { command: 'codex', args: ['--yolo', prompt], toolName: 'Codex CLI' };
		case 'aider-autonomous':
			return { command: 'aider', args: ['--message', prompt, '--yes', '--no-auto-commits'], toolName: 'Aider' };
		case 'opencode-autonomous':
			return { command: 'opencode', args: ['--prompt', prompt], toolName: 'OpenCode' };
		case 'cline-autonomous':
			return { command: 'cline', args: ['--yolo', prompt], toolName: 'Cline CLI' };
		case 'rovo-autonomous':
			return { command: 'acli', args: ['rovodev', 'run', '--yolo', '--jira', jiraUrl, prompt], toolName: 'Rovo' };
		case 'ollama-local': {
			const model = getConfiguredModel() ?? (agentOption as WorkAgentOption & { ollamaModel?: string }).ollamaModel ?? 'qwen2.5-coder:7b';
			return { command: 'aider', args: ['--model', `ollama_chat/${model}`, '--message', prompt, '--yes', '--no-auto-commits'], toolName: `Ollama (${model})` };
		}
	}
}

async function runCopilotForTicket(
	prompt: string,
	repoPath: string,
	autonomous: boolean,
	additionalDirs: string[] = [],
): Promise<void> {
	const args = autonomous
		? ['-p', prompt, '--autopilot', '--allow-all-tools', '--allow-all-paths', '--add-dir', repoPath]
		: ['-i', prompt, '--add-dir', repoPath];
	for (const dir of additionalDirs) {
		args.push('--add-dir', dir);
	}
	await runCommandInteractive('copilot', args, 'Copilot', repoPath);
}

async function runRovoForTicket(
	prompt: string,
	repoPath: string,
	jiraUrl: string,
): Promise<void> {
	const args = ['rovodev', 'run', '--yolo', '--jira', jiraUrl, prompt];
	await runCommandInteractive('acli', args, 'Rovo', repoPath);
}

async function runCursorForTicket(prompt: string, repoPath: string): Promise<void> {
	const args = ['agent', '--yolo', '--workspace', repoPath, '-p', prompt];
	await runCommandInteractive('cursor', args, 'Cursor Agent', repoPath);
}

async function runClaudeCodeForTicket(prompt: string, repoPath: string, interactive: boolean, additionalDirs: string[] = []): Promise<void> {
	const args = interactive ? [prompt] : ['-p', prompt, '--add-dir', repoPath];
	for (const dir of additionalDirs) {
		args.push('--add-dir', dir);
	}
	await runCommandInteractive('claude', args, 'Claude Code', repoPath);
}

async function runGeminiForTicket(prompt: string, repoPath: string): Promise<void> {
	const args = ['-p', prompt];
	await runCommandInteractive('gemini', args, 'Gemini CLI', repoPath);
}

async function runCodexForTicket(prompt: string, repoPath: string, fullAuto: boolean): Promise<void> {
	const args = fullAuto ? ['--full-auto', prompt] : ['--yolo', prompt];
	await runCommandInteractive('codex', args, 'Codex CLI', repoPath);
}

async function runAiderForTicket(prompt: string, repoPath: string): Promise<void> {
	const args = ['--message', prompt, '--yes', '--no-auto-commits'];
	await runCommandInteractive('aider', args, 'Aider', repoPath);
}

async function runOpenCodeForTicket(prompt: string, repoPath: string): Promise<void> {
	const args = ['--prompt', prompt];
	await runCommandInteractive('opencode', args, 'OpenCode', repoPath);
}

async function runClineForTicket(prompt: string, repoPath: string): Promise<void> {
	const args = ['--yolo', prompt];
	await runCommandInteractive('cline', args, 'Cline CLI', repoPath);
}

const ALL_AGENT_OPTIONS: (WorkAgentOption & { cli: string })[] = [
	{
		id: 'copilot-autonomous',
		label: 'Copilot (Autonomous)',
		description: 'Runs non-interactive with auto approvals.',
		cli: 'copilot',
	},
	{
		id: 'copilot-interactive',
		label: 'Copilot (Interactive)',
		description: 'Starts chat mode with the ticket prompt prefilled.',
		cli: 'copilot',
	},
	{
		id: 'claude-code-autonomous',
		label: 'Claude Code (Autonomous)',
		description: 'Runs claude in print mode with prompt.',
		cli: 'claude',
	},
	{
		id: 'claude-code-interactive',
		label: 'Claude Code (Interactive)',
		description: 'Starts interactive session with prompt prefilled.',
		cli: 'claude',
	},
	{
		id: 'cursor-autonomous',
		label: 'Cursor Agent (Autonomous)',
		description: 'Runs cursor agent in yolo mode.',
		cli: 'cursor',
	},
	{
		id: 'gemini-autonomous',
		label: 'Gemini CLI (Autonomous)',
		description: 'Runs Gemini CLI in print mode.',
		cli: 'gemini',
	},
	{
		id: 'codex-full-auto',
		label: 'Codex CLI (Full Auto)',
		description: 'Runs OpenAI Codex with --full-auto flag.',
		cli: 'codex',
	},
	{
		id: 'codex-autonomous',
		label: 'Codex CLI (Yolo)',
		description: 'Runs OpenAI Codex with --yolo flag (no sandbox).',
		cli: 'codex',
	},
	{
		id: 'aider-autonomous',
		label: 'Aider (Autonomous)',
		description: 'Runs aider with --message and --yes flags.',
		cli: 'aider',
	},
	{
		id: 'opencode-autonomous',
		label: 'OpenCode (Autonomous)',
		description: 'Runs opencode with prompt flag.',
		cli: 'opencode',
	},
	{
		id: 'cline-autonomous',
		label: 'Cline CLI (Autonomous)',
		description: 'Runs cline with --yolo auto-approval.',
		cli: 'cline',
	},
	{
		id: 'rovo-autonomous',
		label: 'Rovo (Autonomous)',
		description: 'Runs acli rovodev with yolo mode.',
		cli: 'acli',
	},
	{
		id: 'ollama-local',
		label: 'Ollama Local (via Aider)',
		description: 'Runs a local Ollama model through aider. No cloud API needed.',
		cli: 'aider',
	},
];

async function isCLIAvailable(command: string): Promise<boolean> {
	try {
		await execFileAsync('command', ['-v', command], { shell: true });
		return true;
	} catch {
		return false;
	}
}

export async function getAvailableAgentOptions(): Promise<WorkAgentOption[]> {
	const cliNames = [...new Set(ALL_AGENT_OPTIONS.map((o) => o.cli))];
	const results = await Promise.all(cliNames.map(async (cli) => ({ cli, available: await isCLIAvailable(cli) })));
	const availableSet = new Set(results.filter((r) => r.available).map((r) => r.cli));

	const ollamaAvailable = availableSet.has('aider') && await isOllamaInstalled();

	return ALL_AGENT_OPTIONS
		.filter((o) => {
			if (o.id === 'ollama-local') return ollamaAvailable;
			return availableSet.has(o.cli);
		})
		.map(({ cli: __, ...option }) => option);
}

export async function pickOllamaModel(): Promise<string | null> {
	const configured = getConfiguredModel();
	if (configured) {
		console.log(chalk.gray(`  Using configured Ollama model: ${configured}`));
		return configured;
	}

	const cached = await getCached<string>('ollamaModel');

	if (!(await ensureOllamaServing())) {
		console.log(chalk.red('  Could not start Ollama. Make sure it is installed (brew install ollama).'));
		return null;
	}

	const models = await listOllamaModels();

	if (!models.length) {
		console.log(chalk.yellow('  No Ollama models installed.'));
		const recommended = getRecommendedModel();
		const pull = await askUserChoice(`Pull ${recommended}?`, [
			{ id: 'yes', label: `Yes — pull ${recommended} (recommended for coding)` },
			{ id: 'custom', label: 'Enter a different model name' },
			{ id: 'cancel', label: 'Cancel — go back' },
		]);

		if (pull === 'cancel') return null;

		let modelToPull = recommended;
		if (pull === 'custom') {
			modelToPull = await askUser(chalk.cyan('  Model name (e.g. codellama:13b): '));
			if (!modelToPull.trim()) return null;
		}

		const success = await pullOllamaModel(modelToPull);
		if (!success) return null;
		await setCached('ollamaModel', modelToPull);
		return modelToPull;
	}

	if (cached && models.some((m) => m.name === cached)) {
		const reuse = await askUserChoice(`Last used model: ${cached}`, [
			{ id: 'reuse', label: `Use ${cached} again` },
			{ id: 'pick', label: 'Pick a different model' },
		]);
		if (reuse === 'reuse') return cached;
	}

	const modelChoices = models.map((m) => ({
		id: m.name,
		label: `${m.name} (${m.size})`,
	}));
	modelChoices.push({ id: '__pull__', label: 'Pull a new model...' });

	const chosen = await askUserChoice('Select an Ollama model:', modelChoices);

	if (chosen === '__pull__') {
		const name = await askUser(chalk.cyan('  Model name (e.g. qwen2.5-coder:7b): '));
		if (!name.trim()) return null;
		const success = await pullOllamaModel(name.trim());
		if (!success) return null;
		await setCached('ollamaModel', name.trim());
		return name.trim();
	}

	await setCached('ollamaModel', chosen);
	return chosen;
}

async function dispatchAgent(
	agentOption: WorkAgentOption,
	prompt: string,
	repoPath: string,
	jiraUrl: string,
	additionalDirs: string[] = [],
): Promise<void> {
	switch (agentOption.id) {
		case 'copilot-autonomous':
			await runCopilotForTicket(prompt, repoPath, true, additionalDirs);
			break;
		case 'copilot-interactive':
			await runCopilotForTicket(prompt, repoPath, false, additionalDirs);
			break;
		case 'claude-code-autonomous':
			await runClaudeCodeForTicket(prompt, repoPath, false, additionalDirs);
			break;
		case 'claude-code-interactive':
			await runClaudeCodeForTicket(prompt, repoPath, true, additionalDirs);
			break;
		case 'cursor-autonomous':
			await runCursorForTicket(prompt, repoPath);
			break;
		case 'gemini-autonomous':
			await runGeminiForTicket(prompt, repoPath);
			break;
		case 'codex-full-auto':
			await runCodexForTicket(prompt, repoPath, true);
			break;
		case 'codex-autonomous':
			await runCodexForTicket(prompt, repoPath, false);
			break;
		case 'aider-autonomous':
			await runAiderForTicket(prompt, repoPath);
			break;
		case 'opencode-autonomous':
			await runOpenCodeForTicket(prompt, repoPath);
			break;
		case 'cline-autonomous':
			await runClineForTicket(prompt, repoPath);
			break;
		case 'rovo-autonomous':
			await runRovoForTicket(prompt, repoPath, jiraUrl);
			break;
		case 'ollama-local': {
			const model = getConfiguredModel() ?? (agentOption as WorkAgentOption & { ollamaModel?: string }).ollamaModel ?? 'qwen2.5-coder:7b';
			const args = ['--model', `ollama_chat/${model}`, '--message', prompt, '--yes', '--no-auto-commits'];
			const env = { ...process.env, OLLAMA_API_BASE: getOllamaApiBase() };
			await runCommandInteractiveWithEnv('aider', args, `Ollama (${model})`, repoPath, env);
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Parallel sub-agent execution
// ---------------------------------------------------------------------------

function getParallelSubAgentCount(): number {
	const envVal = process.env.FORGEPILOT_PARALLEL_AGENTS?.trim();
	if (envVal) {
		const n = parseInt(envVal, 10);
		if (!isNaN(n) && n >= 2 && n <= 10) return n;
	}
	return 3;
}

function partitionTodoItems(items: string[], numGroups: number): string[][] {
	const groups: string[][] = Array.from({ length: numGroups }, () => []);
	for (let i = 0; i < items.length; i++) {
		groups[i % numGroups].push(items[i]);
	}
	return groups.filter((g) => g.length > 0);
}

type SubAgentResult = {
	index: number;
	status: 'done' | 'failed';
	error?: string;
	pid: number;
	logFile: string;
};

async function dispatchParallelSubAgents(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	todoItems: string[],
	effectivePath: string,
	jiraUrl: string,
	contributing: string | null,
	clarifications: string,
	axonHint: string,
	figmaSection: string,
	referenceRepoPaths: string[],
): Promise<SubAgentResult[]> {
	const maxAgents = getParallelSubAgentCount();
	const agentCount = Math.min(maxAgents, todoItems.length);
	const groups = partitionTodoItems(todoItems, agentCount);

	console.log(chalk.bold.cyan(`\n  Launching ${groups.length} parallel sub-agents for ${detail.key}...\n`));

	await ensureLogDirs();

	const subJobs: Array<{
		index: number;
		child: ReturnType<typeof spawn>;
		logFile: string;
		logFd: Awaited<ReturnType<typeof fsOpen>>;
		items: string[];
	}> = [];

	for (let i = 0; i < groups.length; i++) {
		const subItems = groups[i];
		const prompt = buildSubTaskPrompt(
			detail,
			subItems,
			todoItems,
			i,
			groups.length,
			contributing ?? undefined,
			clarifications,
			axonHint,
			figmaSection,
		);

		const { command, args, toolName } = resolveAgentCommand(
			agentOption,
			prompt,
			effectivePath,
			jiraUrl,
			referenceRepoPaths,
		);

		const safeKey = detail.key.replace(/[/\\]/g, '-');
		const logFile = path.join(path.resolve(import.meta.dirname, '..', '.cache', 'logs'), `${safeKey}-sub${i + 1}-${Date.now()}.log`);
		const logFd = await fsOpen(logFile, 'w');

		const spawnEnv = agentOption.id === 'ollama-local'
			? { ...process.env, OLLAMA_API_BASE: getOllamaApiBase() }
			: undefined;

		const child = spawn(command, args, {
			stdio: ['ignore', logFd.fd, logFd.fd],
			cwd: effectivePath,
			...(spawnEnv ? { env: spawnEnv } : {}),
		});

		console.log(chalk.gray(`  Sub-agent ${i + 1}/${groups.length} (PID ${child.pid}): ${subItems.length} task(s) → ${toolName}`));
		for (const item of subItems) {
			console.log(chalk.gray(`    • ${item}`));
		}

		subJobs.push({ index: i, child, logFile, logFd, items: subItems });
	}

	console.log(chalk.gray(`\n  All ${groups.length} sub-agents launched. Waiting for completion...\n`));

	const results = await Promise.allSettled(
		subJobs.map(
			({ index, child, logFile, logFd }) =>
				new Promise<SubAgentResult>((resolve) => {
					child.on('error', async (err) => {
						await logFd.close();
						resolve({ index, status: 'failed', error: err.message, pid: child.pid ?? 0, logFile });
					});
					child.on('exit', async (code) => {
						await logFd.close();
						if (code === 0) {
							resolve({ index, status: 'done', pid: child.pid ?? 0, logFile });
						} else {
							resolve({ index, status: 'failed', error: `Exited with code ${code ?? 'unknown'}`, pid: child.pid ?? 0, logFile });
						}
					});
				}),
		),
	);

	const finalResults: SubAgentResult[] = results.map((r) =>
		r.status === 'fulfilled'
			? r.value
			: { index: -1, status: 'failed' as const, error: 'Promise rejected', pid: 0, logFile: '' },
	);

	let doneCount = 0;
	let failedCount = 0;
	for (const result of finalResults) {
		if (result.status === 'done') {
			doneCount++;
			console.log(chalk.green(`  ✓ Sub-agent ${result.index + 1} completed (PID ${result.pid})`));
		} else {
			failedCount++;
			console.log(chalk.red(`  ✗ Sub-agent ${result.index + 1} failed: ${result.error}`));
			console.log(chalk.gray(`    Log: ${result.logFile}`));
		}
	}

	console.log('');
	if (failedCount === 0) {
		console.log(chalk.bold.green(`  ✓ All ${doneCount} sub-agents completed successfully.`));
	} else {
		console.log(chalk.bold.yellow(`  ${doneCount} succeeded, ${failedCount} failed out of ${finalResults.length} sub-agents.`));
	}

	return finalResults;
}

async function dispatchParallelSubAgentsBackground(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	todoItems: string[],
	effectivePath: string,
	jiraUrl: string,
	contributing: string | null,
	clarifications: string,
	axonHint: string,
	figmaSection: string,
	referenceRepoPaths: string[],
): Promise<JobRecord[]> {
	const maxAgents = getParallelSubAgentCount();
	const agentCount = Math.min(maxAgents, todoItems.length);
	const groups = partitionTodoItems(todoItems, agentCount);

	console.log(chalk.bold.cyan(`\n  Launching ${groups.length} parallel sub-agents in background for ${detail.key}...\n`));

	const jobs: JobRecord[] = [];

	for (let i = 0; i < groups.length; i++) {
		const subItems = groups[i];
		const prompt = buildSubTaskPrompt(
			detail,
			subItems,
			todoItems,
			i,
			groups.length,
			contributing ?? undefined,
			clarifications,
			axonHint,
			figmaSection,
		);

		const ticketTitle = String(detail.fields.summary ?? detail.key);
		const subTicketKey = `${detail.key}-sub${i + 1}`;

		const { command, args, toolName } = resolveAgentCommand(agentOption, prompt, effectivePath, jiraUrl, referenceRepoPaths);

		const job = await runCommandBackground(
			command,
			args,
			toolName,
			subTicketKey,
			`${ticketTitle} (sub-agent ${i + 1}/${groups.length})`,
			[effectivePath],
			effectivePath,
			agentOption.id,
		);

		jobs.push(job);

		console.log(chalk.gray(`  Sub-agent ${i + 1}/${groups.length} (PID ${job.pid}): ${subItems.length} task(s)`));
		for (const item of subItems) {
			console.log(chalk.gray(`    • ${item}`));
		}
	}

	return jobs;
}

async function generateTodoPlan(
	detail: JiraIssueDetail,
	contributing: string,
	clarifications: string,
	modifications?: string,
): Promise<string[] | null> {
	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();
	const title = detail.fields.summary ?? '(no title)';
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);

	const prompt = [
		'You are a senior software engineer planning work for a Jira ticket.',
		'Generate a markdown checklist of implementation tasks.',
		'',
		'Output requirements:',
		'- Return ONLY a markdown checklist (no explanation, no JSON, no code fences).',
		'- Format: "- [ ] Task description" (one per line).',
		'- Break work into small, logical, independently committable units.',
		'- Order tasks by dependency (foundational work first).',
		'- Include setup, implementation, tests, and cleanup steps as appropriate.',
		'- Max 15 items.',
		'',
		`Ticket: ${detail.key}`,
		`Title: ${title}`,
		'',
		`Description:\n${description.slice(0, 6000)}`,
		'',
		`Acceptance Criteria:\n${ac.slice(0, 4000)}`,
		contributing ? `\nContributing Guidelines:\n${contributing.slice(0, 2000)}` : '',
		clarifications ? `\nUser Clarifications:\n${clarifications.slice(0, 2000)}` : '',
		modifications ? `\nUser requested modifications:\n${modifications}` : '',
	].filter(Boolean).join('\n');

	try {
		let stdout = '';
		if (preflightAgent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else if (preflightAgent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else {
			return null;
		}

		const items = stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('- [ ]'))
			.map((line) => line.replace(/^- \[ \]\s*/, '').trim())
			.filter(Boolean);

		return items.length > 0 ? items : null;
	} catch {
		return null;
	}
}

async function reviewTodoPlan(
	items: string[],
	detail: JiraIssueDetail,
	contributing: string,
	clarifications: string,
): Promise<{ approved: string[]; action: 'approve' | 'skip'; lastModifications?: string }> {
	const maxRounds = 5;
	let lastModifications: string | undefined;

	for (let round = 0; round < maxRounds; round++) {
		console.log(chalk.bold.cyan(`\n  📋 Proposed plan for ${detail.key}:\n`));
		for (let i = 0; i < items.length; i++) {
			console.log(chalk.white(`  ${i + 1}. ${items[i]}`));
		}
		console.log('');

		if (isVoiceModeActive()) {
			printAndSpeak(`${items.length} tasks planned. Review and approve, modify, or restart.`);
		}

		const choice = await askUserChoice('What would you like to do?', [
			{ id: 'approve', label: 'Looks good — start coding' },
			{ id: 'modify', label: 'Modify the plan — tell me what to change' },
			{ id: 'restart', label: 'Start over — re-analyze from scratch' },
			{ id: 'skip', label: 'Skip plan review — let the agent decide' },
		]);

		if (choice.startsWith('__unmatched__:')) {
			const modifications = choice.slice('__unmatched__:'.length);
			lastModifications = modifications;
			console.log(chalk.gray('  Treating your response as a plan modification...'));
			if (isVoiceModeActive()) {
				printAndSpeak('Updating the plan with your feedback.');
			}
			const updated = await generateTodoPlan(detail, contributing, clarifications, modifications);
			if (updated) {
				items = updated;
			} else {
				console.log(chalk.yellow('  Could not regenerate. Showing original plan.'));
			}
			continue;
		}

		if (choice === 'approve') {
			return { approved: items, action: 'approve', lastModifications };
		}

		if (choice === 'skip') {
			return { approved: [], action: 'skip' };
		}

		if (choice === 'modify') {
			const modifications = await askUser(chalk.cyan('  What should be changed? '));
			if (!modifications) continue;
			lastModifications = modifications;

			console.log(chalk.gray('  Regenerating plan with your modifications...'));
			const updated = await generateTodoPlan(detail, contributing, clarifications, modifications);
			if (updated) {
				items = updated;
			} else {
				console.log(chalk.yellow('  Could not regenerate. Showing original plan.'));
			}
			continue;
		}

		if (choice === 'restart') {
			console.log(chalk.gray('  Re-analyzing ticket from scratch...'));
			const fresh = await generateTodoPlan(detail, contributing, clarifications);
			if (fresh) {
				items = fresh;
			} else {
				console.log(chalk.yellow('  Could not regenerate. Showing original plan.'));
			}
			continue;
		}
	}

	return { approved: items, action: 'approve', lastModifications };
}

async function generateCustomTodoPlan(
	taskDescription: string,
	contributing: string,
	clarifications: string,
	modifications?: string,
): Promise<string[] | null> {
	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();

	const prompt = [
		'You are a senior software engineer planning implementation tasks.',
		'Generate a markdown checklist of implementation tasks for the following custom task.',
		'',
		'Output requirements:',
		'- Return ONLY a markdown checklist (no explanation, no JSON, no code fences).',
		'- Format: "- [ ] Task description" (one per line).',
		'- Break work into small, logical, independently committable units.',
		'- Order tasks by dependency (foundational work first).',
		'- Include setup, implementation, tests, and cleanup steps as appropriate.',
		'- Max 15 items.',
		'',
		`Task Description:\n${taskDescription.slice(0, 6000)}`,
		contributing ? `\nContributing Guidelines:\n${contributing.slice(0, 2000)}` : '',
		clarifications ? `\nUser Clarifications:\n${clarifications.slice(0, 2000)}` : '',
		modifications ? `\nUser requested modifications:\n${modifications}` : '',
	].filter(Boolean).join('\n');

	try {
		let stdout = '';
		if (preflightAgent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else if (preflightAgent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else {
			return null;
		}

		const items = stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('- [ ]'))
			.map((line) => line.replace(/^- \[ \]\s*/, '').trim())
			.filter(Boolean);

		return items.length > 0 ? items : null;
	} catch {
		return null;
	}
}

async function reviewCustomTodoPlan(
	items: string[],
	taskDescription: string,
	contributing: string,
	clarifications: string,
): Promise<{ approved: string[]; action: 'approve' | 'skip'; lastModifications?: string }> {
	const maxRounds = 5;
	let lastModifications: string | undefined;

	for (let round = 0; round < maxRounds; round++) {
		console.log(chalk.bold.cyan(`\n  Proposed plan for custom task:\n`));
		for (let i = 0; i < items.length; i++) {
			console.log(chalk.white(`  ${i + 1}. ${items[i]}`));
		}
		console.log('');

		if (isVoiceModeActive()) {
			printAndSpeak(`${items.length} tasks planned. Review and approve, modify, or restart.`);
		}

		const choice = await askUserChoice('What would you like to do?', [
			{ id: 'approve', label: 'Looks good — start coding' },
			{ id: 'modify', label: 'Modify the plan — tell me what to change' },
			{ id: 'restart', label: 'Start over — re-analyze from scratch' },
			{ id: 'skip', label: 'Skip plan review — let the agent decide' },
		]);

		if (choice.startsWith('__unmatched__:')) {
			const modifications = choice.slice('__unmatched__:'.length);
			lastModifications = modifications;
			console.log(chalk.gray('  Treating your response as a plan modification...'));
			if (isVoiceModeActive()) {
				printAndSpeak('Updating the plan with your feedback.');
			}
			const updated = await generateCustomTodoPlan(taskDescription, contributing, clarifications, modifications);
			if (updated) {
				items = updated;
			} else {
				console.log(chalk.yellow('  Could not regenerate. Showing original plan.'));
			}
			continue;
		}

		if (choice === 'approve') {
			return { approved: items, action: 'approve', lastModifications };
		}

		if (choice === 'skip') {
			return { approved: [], action: 'skip' };
		}

		if (choice === 'modify') {
			const modifications = await askUser(chalk.cyan('  What should be changed? '));
			if (!modifications) continue;
			lastModifications = modifications;

			console.log(chalk.gray('  Regenerating plan with your modifications...'));
			const updated = await generateCustomTodoPlan(taskDescription, contributing, clarifications, modifications);
			if (updated) {
				items = updated;
			} else {
				console.log(chalk.yellow('  Could not regenerate. Showing original plan.'));
			}
			continue;
		}

		if (choice === 'restart') {
			console.log(chalk.gray('  Re-analyzing task from scratch...'));
			const fresh = await generateCustomTodoPlan(taskDescription, contributing, clarifications);
			if (fresh) {
				items = fresh;
			} else {
				console.log(chalk.yellow('  Could not regenerate. Showing original plan.'));
			}
			continue;
		}
	}

	return { approved: items, action: 'approve', lastModifications };
}

async function askCustomTaskClarifications(
	taskDescription: string,
	contributing: string,
): Promise<string> {
	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();

	const prompt = [
		'You are a senior software engineer preparing to implement a task.',
		'Analyze the task description and generate 1-3 clarifying questions that would help you implement it better.',
		'',
		'Output requirements:',
		'- Return ONLY a JSON array of question strings.',
		'- Each question should be concise (one sentence).',
		'- Ask about ambiguities, missing details, or important decisions.',
		'- If the task is clear enough, return an empty array: []',
		'- Max 3 questions.',
		'- Example: ["Should this support both iOS and Android?", "Which database should be used?"]',
		'',
		`Task Description:\n${taskDescription.slice(0, 4000)}`,
		contributing ? `\nContributing Guidelines:\n${contributing.slice(0, 1000)}` : '',
	].filter(Boolean).join('\n');

	try {
		let stdout = '';
		if (preflightAgent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else if (preflightAgent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else {
			return '';
		}

		const jsonMatch = stdout.match(/\[[\s\S]*?\]/);
		if (!jsonMatch) return '';

		const questions = JSON.parse(jsonMatch[0]) as string[];
		if (!Array.isArray(questions) || questions.length === 0) return '';

		console.log(chalk.bold.yellow(`\n  ${questions.length} clarification(s) before starting:\n`));

		if (isVoiceModeActive()) {
			printAndSpeak(`${questions.length} clarification${questions.length === 1 ? '' : 's'} needed.`);
		}

		const answers: string[] = [];
		for (let i = 0; i < questions.length; i++) {
			console.log(chalk.white(`  ${i + 1}. ${questions[i]}`));
			const answer = await askUser(chalk.cyan('     Answer: '));
			answers.push(`Q: ${questions[i]}\nA: ${answer || '(no answer)'}`);
		}

		return answers.join('\n\n');
	} catch {
		return '';
	}
}

export async function launchAgentForRepos(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<void> {
	if (agentOption.id === 'ollama-local') {
		await ensureOllamaServing();
		const model = await pickOllamaModel();
		if (!model) throw new Error('No Ollama model selected.');
		(agentOption as WorkAgentOption & { ollamaModel: string }).ollamaModel = model;
	}

	const paths = [...repoPaths.values()];

	const firstRepoContributing = await readContributing(paths[0]);
	const preflight = await runPreflightChecks(detail, !!firstRepoContributing);
	const clarifications = formatClarifications(preflight);
	const referenceRepoPaths = preflight.referenceRepoPaths.filter((p) => !paths.includes(p));

	if (referenceRepoPaths.length) {
		console.log(chalk.green(`  ✓ ${referenceRepoPaths.length} reference repo(s) will be shared with the agent:`));
		for (const rp of referenceRepoPaths) {
			console.log(chalk.gray(`    → ${rp}`));
		}
	}

	if (paths.length > 1) {
		await promptMultiRepoBranchStrategy(paths, detail.key.toUpperCase());
	}

	const figmaSection = await fetchFigmaDesignContext(detail);
	const jiraUrl = getJiraBrowseUrl(detail);

	let preApprovedPlan = false;
	let approvedTodoItems: string[] = [];
	let existingPlanContinue = false;
	let userModifications: string | undefined;
	let planReviewModifications: string | undefined;

	const existingPlan = await handleExistingPlan(detail.key, paths);
	if (existingPlan.choice === 'continue') {
		existingPlanContinue = true;
	} else {
		const modifications = existingPlan.choice === 'modify'
			? await askUser(chalk.cyan('  What should be changed? '))
			: undefined;
		userModifications = modifications;

		console.log(chalk.gray('\n  Generating implementation plan...'));
		const planItems = await generateTodoPlan(detail, firstRepoContributing ?? '', clarifications, modifications);
		if (planItems) {
			const result = await reviewTodoPlan(planItems, detail, firstRepoContributing ?? '', clarifications);
			if (result.action === 'approve') {
				approvedTodoItems = result.approved;
				preApprovedPlan = true;
			}
			planReviewModifications = result.lastModifications;
		} else {
			console.log(chalk.gray('  Could not generate plan. The agent will create its own.'));
		}
	}

	const baseBranchOverride = extractBaseBranchOverride(planReviewModifications ?? '')
		?? extractBaseBranchOverride(userModifications ?? '')
		?? extractBaseBranchOverride(approvedTodoItems.join('\n'))
		?? extractBaseBranchOverride(getDescriptionText(detail))
		?? extractBaseBranchOverride(commentsText(detail));
	if (baseBranchOverride) {
		console.log(chalk.green(`  ✓ Base branch override detected: ${baseBranchOverride}`));
	}

	const parallelThreshold = 4;
	let useParallelSubAgents = false;
	if (preApprovedPlan && approvedTodoItems.length >= parallelThreshold && !existingPlanContinue) {
		const agentCount = Math.min(getParallelSubAgentCount(), approvedTodoItems.length);
		useParallelSubAgents = true;
		console.log(chalk.cyan(`  ⚡ Spawning ${agentCount} parallel agents for ${approvedTodoItems.length} tasks.`));
	}

	await transitionIssueToInProgress(detail);
	await notifySlackStatus(`ForgePilot started ${agentOption.label} for ${detail.key} across ${paths.length} repo(s).${useParallelSubAgents ? ' (parallel mode)' : ''}`);

	for (const repoPath of paths) {
		let axonChild: ReturnType<typeof startAxonWatch> = null;
		try {
			console.log(chalk.bold(`\nPreparing ${repoPath} for ${detail.key}...`));
			const effectivePath = await prepareRepoForWork(repoPath, detail.key, false, detail, baseBranchOverride ?? undefined);

			const ticketTitle = String(detail.fields.summary ?? detail.key);
			const { reviewMode, reviewComments } = await handleReviewDetection(effectivePath, detail.key, ticketTitle);

			let resumeMode = existingPlanContinue;
			if (!resumeMode && !reviewMode) {
				({ resumeMode } = await handleCheckpointResume(effectivePath, detail.key));
			}

			if (preApprovedPlan && !resumeMode && !reviewMode && approvedTodoItems.length > 0) {
				const todoPath = todoFilePath(effectivePath, detail.key);
				const todoContent = [
					`# ${detail.key}: ${detail.fields.summary ?? detail.key}`,
					'',
					...approvedTodoItems.map((item) => `- [ ] ${item}`),
					'',
				].join('\n');
				await fs.writeFile(todoPath, todoContent, 'utf8');
				console.log(chalk.green(`  ✓ Pre-approved plan written to ${path.basename(todoPath)}`));
			}

			const contributing = repoPath === paths[0] ? firstRepoContributing : await readContributing(effectivePath);
			if (contributing) {
				console.log(chalk.gray(`  Found CONTRIBUTING.md / AGENTS.md in ${effectivePath}`));
			}

			const axonHint = getAxonPromptHint(effectivePath);
			logAxonStatus(effectivePath);
			axonChild = startAxonWatch(effectivePath);

			// --- Parallel sub-agent path ---
			if (useParallelSubAgents && preApprovedPlan && !resumeMode && !reviewMode && approvedTodoItems.length >= 2) {
				const subResults = await dispatchParallelSubAgents(
					detail,
					agentOption,
					approvedTodoItems,
					effectivePath,
					jiraUrl,
					contributing,
					clarifications,
					axonHint,
					figmaSection,
					referenceRepoPaths,
				);

				const failedSubs = subResults.filter((r) => r.status === 'failed');
				if (failedSubs.length > 0) {
					console.log(chalk.yellow(`\n  ${failedSubs.length} sub-agent(s) failed. Check logs for details:`));
					for (const f of failedSubs) {
						console.log(chalk.gray(`    Sub-agent ${f.index + 1}: ${f.logFile}`));
					}
				}

				await notifySlackStatus(
					`ForgePilot parallel execution for ${detail.key}: ${subResults.filter((r) => r.status === 'done').length}/${subResults.length} sub-agents succeeded.`,
				);
			} else {
				// --- Standard single-agent path ---
				let priorAnswers = '';
				const maxQaRounds = 5;
				const usePreApproved = preApprovedPlan && !resumeMode && !reviewMode;

				for (let qaRound = 0; qaRound < maxQaRounds; qaRound++) {
					const isResume = resumeMode && qaRound === 0;
					const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint, figmaSection, priorAnswers, isResume, reviewMode && qaRound === 0 ? reviewComments : [], usePreApproved && qaRound === 0);

					await saveCheckpoint(detail.key, {
						ticketKey: detail.key,
						agentId: agentOption.id,
						agentLabel: agentOption.label,
						repoPath,
						effectivePath,
						startedAt: (await loadCheckpoint(detail.key))?.startedAt ?? new Date().toISOString(),
						lastUpdatedAt: new Date().toISOString(),
					});

					console.log(chalk.bold(`\nRunning ${agentOption.label} in ${effectivePath} ${isResume ? '(resuming from checkpoint) ' : ''}...`));
					await dispatchAgent(agentOption, prompt, effectivePath, jiraUrl, referenceRepoPaths);

					const questions = await readQuestionsFile(effectivePath, detail.key);
					if (!questions) break;

					console.log(chalk.yellow(`\n  Agent paused with ${questions.length} question(s). Routing for answers...`));
					const qaPairs = await routeQuestions(questions, detail.key);
					await writeAnswersFile(effectivePath, detail.key, qaPairs);

					const newAnswers = qaPairs.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n');
					priorAnswers = priorAnswers ? `${priorAnswers}\n\n${newAnswers}` : newAnswers;

					await notifySlackStatus(`ForgePilot re-launching ${agentOption.label} for ${detail.key} after answering ${questions.length} question(s).`);
				}
			}

			await cleanupTodoFiles(effectivePath);
			await cleanupQuestionFiles(effectivePath);
			await clearCheckpoint(detail.key);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(chalk.yellow(`  Checkpoint preserved for ${detail.key}. Resume on next run.`));
			await notifySlackStatus(
				`ForgePilot error for ${detail.key} in ${repoPath} using ${agentOption.label}: ${message}. Checkpoint preserved for resume.`,
			);
			throw error;
		} finally {
			stopAxonWatch(axonChild);
		}
	}

	await notifySlackStatus(`ForgePilot completed ${agentOption.label} for ${detail.key} successfully.`);
}

export async function launchAgentInBackground(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<JobRecord> {
	const paths = [...repoPaths.values()];

	const firstRepoContributing = await readContributing(paths[0]);
	const preflight = await runPreflightChecks(detail, !!firstRepoContributing);
	const clarifications = formatClarifications(preflight);
	const referenceRepoPaths = preflight.referenceRepoPaths.filter((p) => !paths.includes(p));

	const figmaSection = await fetchFigmaDesignContext(detail);
	const jiraUrl = getJiraBrowseUrl(detail);

	let preApprovedPlan = false;
	let approvedTodoItems: string[] = [];
	let existingPlanContinue = false;
	let userModifications: string | undefined;
	let planReviewModifications: string | undefined;

	const existingPlan = await handleExistingPlan(detail.key, paths);
	if (existingPlan.choice === 'continue') {
		existingPlanContinue = true;
	} else {
		const modifications = existingPlan.choice === 'modify'
			? await askUser(chalk.cyan('  What should be changed? '))
			: undefined;
		userModifications = modifications;

		console.log(chalk.gray('\n  Generating implementation plan...'));
		const planItems = await generateTodoPlan(detail, firstRepoContributing ?? '', clarifications, modifications);
		if (planItems) {
			const result = await reviewTodoPlan(planItems, detail, firstRepoContributing ?? '', clarifications);
			if (result.action === 'approve') {
				approvedTodoItems = result.approved;
				preApprovedPlan = true;
			}
			planReviewModifications = result.lastModifications;
		} else {
			console.log(chalk.gray('  Could not generate plan. The agent will create its own.'));
		}
	}

	const baseBranchOverride = extractBaseBranchOverride(planReviewModifications ?? '')
		?? extractBaseBranchOverride(userModifications ?? '')
		?? extractBaseBranchOverride(approvedTodoItems.join('\n'))
		?? extractBaseBranchOverride(getDescriptionText(detail))
		?? extractBaseBranchOverride(commentsText(detail));
	if (baseBranchOverride) {
		console.log(chalk.green(`  ✓ Base branch override detected: ${baseBranchOverride}`));
	}

	const parallelThreshold = 4;
	let useParallelSubAgents = false;
	if (preApprovedPlan && approvedTodoItems.length >= parallelThreshold && !existingPlanContinue) {
		const agentCount = Math.min(getParallelSubAgentCount(), approvedTodoItems.length);
		useParallelSubAgents = true;
		console.log(chalk.cyan(`  ⚡ Spawning ${agentCount} parallel background agents for ${approvedTodoItems.length} tasks.`));
	}

	await transitionIssueToInProgress(detail);

	const repoPath = paths[0];
	const effectivePath = await prepareRepoForWork(repoPath, detail.key, false, detail, baseBranchOverride ?? undefined);
	const ticketTitle = String(detail.fields.summary ?? detail.key);
	const { reviewMode, reviewComments } = await handleReviewDetection(effectivePath, detail.key, ticketTitle);

	let resumeMode = existingPlanContinue;
	if (!resumeMode && !reviewMode) {
		({ resumeMode } = await handleCheckpointResume(effectivePath, detail.key));
	}

	if (preApprovedPlan && !resumeMode && !reviewMode && approvedTodoItems.length > 0) {
		const todoPath = todoFilePath(effectivePath, detail.key);
		const todoContent = [
			`# ${detail.key}: ${detail.fields.summary ?? detail.key}`,
			'',
			...approvedTodoItems.map((item) => `- [ ] ${item}`),
			'',
		].join('\n');
		await fs.writeFile(todoPath, todoContent, 'utf8');
	}

	const contributing = await readContributing(effectivePath);
	const axonHint = getAxonPromptHint(effectivePath);

	// --- Parallel sub-agent background path ---
	if (useParallelSubAgents && preApprovedPlan && !resumeMode && !reviewMode && approvedTodoItems.length >= 2) {
		let effectiveOption = agentOption;
		if (agentOption.id === 'ollama-local') {
			await ensureOllamaServing();
			const model = await pickOllamaModel();
			if (!model) throw new Error('No Ollama model selected.');
			effectiveOption = { ...agentOption, ollamaModel: model } as WorkAgentOption & { ollamaModel: string };
		}

		const subJobs = await dispatchParallelSubAgentsBackground(
			detail,
			effectiveOption,
			approvedTodoItems,
			effectivePath,
			jiraUrl,
			contributing,
			clarifications,
			axonHint,
			figmaSection,
			referenceRepoPaths,
		);

		startAxonWatch(effectivePath);

		await notifySlackStatus(
			`ForgePilot started ${subJobs.length} parallel sub-agents in background for ${detail.key}.`,
		);

		// Return the first sub-job as the primary job record
		return subJobs[0];
	}

	// --- Standard single-agent background path ---
	const usePreApproved = preApprovedPlan && !resumeMode && !reviewMode;
	const isResume = resumeMode;

	const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint, figmaSection, '', isResume, reviewMode ? reviewComments : [], usePreApproved);

	await saveCheckpoint(detail.key, {
		ticketKey: detail.key,
		agentId: agentOption.id,
		agentLabel: agentOption.label,
		repoPath,
		effectivePath,
		startedAt: (await loadCheckpoint(detail.key))?.startedAt ?? new Date().toISOString(),
		lastUpdatedAt: new Date().toISOString(),
	});

	let effectiveOption = agentOption;
	if (agentOption.id === 'ollama-local') {
		await ensureOllamaServing();
		const model = await pickOllamaModel();
		if (!model) throw new Error('No Ollama model selected.');
		effectiveOption = { ...agentOption, ollamaModel: model } as WorkAgentOption & { ollamaModel: string };
	}

	const { command, args, toolName } = resolveAgentCommand(effectiveOption, prompt, effectivePath, jiraUrl, referenceRepoPaths);

	const job = await runCommandBackground(
		command,
		args,
		toolName,
		detail.key,
		ticketTitle,
		paths,
		effectivePath,
		effectiveOption.id,
	);

	startAxonWatch(effectivePath);

	await notifySlackStatus(`ForgePilot started ${effectiveOption.label} for ${detail.key} in background (PID ${job.pid}).`);

	return job;
}

export function resolveAgentOptionById(id: string): WorkAgentOption | undefined {
	const match = ALL_AGENT_OPTIONS.find((o) => o.id === id);
	if (!match) return undefined;
	const { id: agentId, label, description } = match;
	return { id: agentId, label, description };
}

export async function launchMultipleTickets(
	details: JiraIssueDetail[],
	agentOption: WorkAgentOption,
	onStatusChange: (statuses: TicketRunStatus[]) => void,
): Promise<TicketRunStatus[]> {
	const statuses: TicketRunStatus[] = details.map((d) => ({
		ticketKey: d.key,
		title: String(d.fields.summary ?? d.key),
		status: 'queued',
		agent: agentOption.label,
		repos: [],
	}));
	onStatusChange(statuses);

	const resolutions = await resolveRepoPathsForMultipleTickets(details);

	for (const [i, detail] of details.entries()) {
		const resolution = resolutions.get(detail.key);
		if (resolution) {
			statuses[i].repos = [...resolution.repoPaths.values()];
		}
	}
	onStatusChange(statuses);

	const hasWorktreeNeeds = [...resolutions.values()].some((r) => r.needsWorktree.size > 0);
	let useSingleBranch = false;

	if (hasWorktreeNeeds) {
		const ticketKeys = details.map((d) => d.key).join(', ');
		console.log(chalk.cyan(`\n  Multiple tickets (${ticketKeys}) share the same repo(s).`));

		if (isVoiceModeActive()) {
			printAndSpeak('These tickets share repos. Should all work go into a single branch, or separate branches?');
		}

		const choice = await askUserChoice(
			'Branch strategy for shared repos:',
			[
				{ id: 'single', label: `Single branch — all work on "${details[0].key.toUpperCase()}", run sequentially` },
				{ id: 'separate', label: 'Separate branches per ticket — run in parallel with worktrees' },
			],
		);

		if (choice === 'single') {
			useSingleBranch = true;
			for (const resolution of resolutions.values()) {
				resolution.needsWorktree.clear();
			}
			console.log(chalk.green(`  ✓ All work will go into branch "${details[0].key.toUpperCase()}", running sequentially.`));
		} else {
			console.log(chalk.green('  ✓ Each ticket gets its own branch. Running in parallel with worktrees.'));
		}
	}

	type TicketPlanData = {
		clarifications: string;
		referenceRepoPaths: string[];
		contributing: string | null;
		figmaSection: string;
		approvedTodoItems: string[];
		preApprovedPlan: boolean;
		existingPlanContinue: boolean;
		baseBranchOverride?: string;
		useParallelSubAgents: boolean;
	};
	const ticketPlans = new Map<string, TicketPlanData>();

	console.log(chalk.bold.cyan(`\n  Reviewing plans for ${details.length} ticket(s)...\n`));

	for (const detail of details) {
		const resolution = resolutions.get(detail.key);
		if (!resolution) continue;

		const paths = [...resolution.repoPaths.values()];
		const contributing = await readContributing(paths[0]);
		const preflight = await runPreflightChecks(detail, !!contributing);
		const clarifications = formatClarifications(preflight);
		const refRepoPaths = preflight.referenceRepoPaths.filter((p) => !paths.includes(p));
		const figmaSection = await fetchFigmaDesignContext(detail);

		let approvedTodoItems: string[] = [];
		let preApprovedPlan = false;
		let existingPlanContinue = false;
		let userModifications: string | undefined;
		let planReviewModifications: string | undefined;

		console.log(chalk.bold(`\n  ── ${detail.key}: ${detail.fields.summary ?? detail.key} ──`));

		const existingPlan = await handleExistingPlan(detail.key, paths);
		if (existingPlan.choice === 'continue') {
			existingPlanContinue = true;
		} else {
			const modifications = existingPlan.choice === 'modify'
				? await askUser(chalk.cyan('  What should be changed? '))
				: undefined;
			userModifications = modifications;

			console.log(chalk.gray('  Generating implementation plan...'));
			const planItems = await generateTodoPlan(detail, contributing ?? '', clarifications, modifications);
			if (planItems) {
				const result = await reviewTodoPlan(planItems, detail, contributing ?? '', clarifications);
				if (result.action === 'approve') {
					approvedTodoItems = result.approved;
					preApprovedPlan = true;
				}
				planReviewModifications = result.lastModifications;
			} else {
				console.log(chalk.gray('  Could not generate plan. The agent will create its own.'));
			}
		}

		const baseBranchOverride = extractBaseBranchOverride(planReviewModifications ?? '')
			?? extractBaseBranchOverride(userModifications ?? '')
			?? extractBaseBranchOverride(approvedTodoItems.join('\n'))
			?? extractBaseBranchOverride(getDescriptionText(detail))
			?? extractBaseBranchOverride(commentsText(detail));
		if (baseBranchOverride) {
			console.log(chalk.green(`  ✓ Base branch override detected: ${baseBranchOverride}`));
		}

		const parallelThreshold = 4;
		let useParallelSubAgents = false;
		if (preApprovedPlan && approvedTodoItems.length >= parallelThreshold && !existingPlanContinue) {
			const agentCount = Math.min(getParallelSubAgentCount(), approvedTodoItems.length);
			useParallelSubAgents = true;
			console.log(chalk.cyan(`  ⚡ [${detail.key}] Spawning ${agentCount} parallel agents for ${approvedTodoItems.length} tasks.`));
		}

		ticketPlans.set(detail.key, {
			clarifications,
			referenceRepoPaths: refRepoPaths,
			contributing,
			figmaSection,
			approvedTodoItems,
			preApprovedPlan,
			existingPlanContinue,
			baseBranchOverride: baseBranchOverride ?? undefined,
			useParallelSubAgents,
		});
	}

	console.log(chalk.bold.green(`\n  ✓ All plans reviewed. Starting execution...\n`));

	const runTicket = async (detail: JiraIssueDetail, i: number) => {
		const resolution = resolutions.get(detail.key);
		if (!resolution) {
			statuses[i].status = 'failed';
			statuses[i].error = 'Could not resolve repositories.';
			onStatusChange(statuses);
			return;
		}

		statuses[i].status = 'running';
		onStatusChange(statuses);

		const paths = [...resolution.repoPaths.values()];
		const worktreePaths: string[] = [];
		const planData = ticketPlans.get(detail.key);
		const clarifications = planData?.clarifications ?? '';
		const refRepoPaths = planData?.referenceRepoPaths ?? [];
		const firstRepoContributing = planData?.contributing ?? null;
		const figmaSection = planData?.figmaSection ?? '';
		const preApprovedPlan = planData?.preApprovedPlan ?? false;
		const approvedTodoItems = planData?.approvedTodoItems ?? [];
		const existingPlanContinue = planData?.existingPlanContinue ?? false;
		const baseBranchOverride = planData?.baseBranchOverride;
		const useParallelSubAgents = planData?.useParallelSubAgents ?? false;

		try {
			const jiraUrl = getJiraBrowseUrl(detail);

			await transitionIssueToInProgress(detail);

			const effectiveBranchKey = useSingleBranch ? details[0].key : detail.key;

			for (const repoPath of paths) {
				const useWorktree = resolution.needsWorktree.has(repoPath);
				let axonChild: ReturnType<typeof startAxonWatch> = null;

				try {
					const effectivePath = await prepareRepoForWork(repoPath, effectiveBranchKey, useWorktree, detail, baseBranchOverride);
					if (useWorktree) worktreePaths.push(effectivePath);

					const ticketTitle = String(detail.fields.summary ?? detail.key);
					const { reviewMode, reviewComments } = await handleReviewDetection(effectivePath, detail.key, ticketTitle);

					let resumeMode = existingPlanContinue;
					if (!resumeMode && !reviewMode) {
						({ resumeMode } = await handleCheckpointResume(effectivePath, detail.key));
					}

					if (preApprovedPlan && !resumeMode && !reviewMode && approvedTodoItems.length > 0) {
						const todoPath = todoFilePath(effectivePath, detail.key);
						const todoContent = [
							`# ${detail.key}: ${detail.fields.summary ?? detail.key}`,
							'',
							...approvedTodoItems.map((item) => `- [ ] ${item}`),
							'',
						].join('\n');
						await fs.writeFile(todoPath, todoContent, 'utf8');
						console.log(chalk.green(`  ✓ Pre-approved plan written to ${path.basename(todoPath)}`));
					}

					const contributing =
						repoPath === paths[0] ? firstRepoContributing : await readContributing(effectivePath);
					const axonHint = getAxonPromptHint(effectivePath);
					axonChild = startAxonWatch(effectivePath);

					// --- Parallel sub-agent path ---
					if (useParallelSubAgents && preApprovedPlan && !resumeMode && !reviewMode && approvedTodoItems.length >= 2) {
						await dispatchParallelSubAgents(
							detail,
							agentOption,
							approvedTodoItems,
							effectivePath,
							jiraUrl,
							contributing,
							clarifications,
							axonHint,
							figmaSection,
							refRepoPaths,
						);
					} else {
						// --- Standard single-agent path ---
						const usePreApproved = preApprovedPlan && !resumeMode && !reviewMode;
						let priorAnswers = '';
						const maxQaRounds = 5;

						for (let qaRound = 0; qaRound < maxQaRounds; qaRound++) {
							const isResume = resumeMode && qaRound === 0;
							const prompt = buildWorkPrompt(detail, contributing ?? undefined, clarifications, axonHint, figmaSection, priorAnswers, isResume, reviewMode && qaRound === 0 ? reviewComments : [], usePreApproved && qaRound === 0);

							await saveCheckpoint(detail.key, {
								ticketKey: detail.key,
								agentId: agentOption.id,
								agentLabel: agentOption.label,
								repoPath,
								effectivePath,
								startedAt: (await loadCheckpoint(detail.key))?.startedAt ?? new Date().toISOString(),
								lastUpdatedAt: new Date().toISOString(),
							});

							await dispatchAgent(agentOption, prompt, effectivePath, jiraUrl, refRepoPaths);

							const questions = await readQuestionsFile(effectivePath, detail.key);
							if (!questions) break;

							const qaPairs = await routeQuestions(questions, detail.key);
							await writeAnswersFile(effectivePath, detail.key, qaPairs);

							const newAnswers = qaPairs.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n');
							priorAnswers = priorAnswers ? `${priorAnswers}\n\n${newAnswers}` : newAnswers;
						}
					}

					await cleanupTodoFiles(effectivePath);
					await cleanupQuestionFiles(effectivePath);
					await clearCheckpoint(detail.key);
				} finally {
					stopAxonWatch(axonChild);
				}
			}

			statuses[i].status = 'done';
			statuses[i].worktreePaths = worktreePaths;
			await notifySlackStatus(`ForgePilot completed ${agentOption.label} for ${detail.key} successfully.`);
		} catch (error) {
			statuses[i].status = 'failed';
			statuses[i].error = error instanceof Error ? error.message : String(error);
			statuses[i].worktreePaths = worktreePaths;
			await notifySlackStatus(
				`ForgePilot error for ${detail.key} using ${agentOption.label}: ${statuses[i].error}`,
			);
		}

		onStatusChange(statuses);
	};

	if (useSingleBranch) {
		for (const [i, detail] of details.entries()) {
			await runTicket(detail, i);
		}
	} else {
		await Promise.allSettled(details.map((detail, i) => runTicket(detail, i)));
	}

	return statuses;
}

export async function launchMultipleTicketsInBackground(
	details: JiraIssueDetail[],
	agentOption: WorkAgentOption,
): Promise<JobRecord[]> {
	const resolutions = await resolveRepoPathsForMultipleTickets(details);

	const jobs: JobRecord[] = [];

	for (const detail of details) {
		const resolution = resolutions.get(detail.key);
		if (!resolution) continue;

		const paths = [...resolution.repoPaths.values()];
		const repoPaths = resolution.repoPaths;

		try {
			const job = await launchAgentInBackground(detail, agentOption, repoPaths);
			jobs.push(job);
			console.log(chalk.green(`  ✓ ${detail.key} launched in background (PID ${job.pid})`));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.log(chalk.red(`  ✗ ${detail.key} failed to launch: ${msg}`));
			await registerJob({
				id: detail.key,
				ticketKey: detail.key,
				title: String(detail.fields.summary ?? detail.key),
				agent: agentOption.label,
				pid: 0,
				logFile: getLogFilePath(detail.key),
				status: 'failed',
				error: msg,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				repos: paths,
				effectivePaths: [],
			});
		}
	}

	return jobs;
}

export async function launchAgentForCustomTask(
	taskDescription: string,
	branchName: string,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<void> {
	if (agentOption.id === 'ollama-local') {
		await ensureOllamaServing();
		const model = await pickOllamaModel();
		if (!model) throw new Error('No Ollama model selected.');
		(agentOption as WorkAgentOption & { ollamaModel: string }).ollamaModel = model;
	}

	const paths = [...repoPaths.values()];
	const contributing = await readContributing(paths[0]);

	if (paths.length > 1) {
		await promptMultiRepoBranchStrategy(paths, branchName);
	}

	console.log(chalk.gray('\n  Analyzing task and checking for clarifications...'));
	const clarifications = await askCustomTaskClarifications(taskDescription, contributing ?? '');

	let preApprovedPlan = false;
	let approvedTodoItems: string[] = [];

	console.log(chalk.gray('\n  Generating implementation plan...'));
	const planItems = await generateCustomTodoPlan(taskDescription, contributing ?? '', clarifications);
	let customBaseBranchOverride: string | null = null;
	if (planItems) {
		const result = await reviewCustomTodoPlan(planItems, taskDescription, contributing ?? '', clarifications);
		if (result.action === 'approve') {
			approvedTodoItems = result.approved;
			preApprovedPlan = true;
		}
		customBaseBranchOverride = extractBaseBranchOverride(result.lastModifications ?? '')
			?? extractBaseBranchOverride(approvedTodoItems.join('\n'));
		if (customBaseBranchOverride) {
			console.log(chalk.green(`  ✓ Base branch override detected: ${customBaseBranchOverride}`));
		}
	} else {
		console.log(chalk.gray('  Could not generate plan. The agent will create its own.'));
	}

	await notifySlackStatus(`ForgePilot started ${agentOption.label} for custom task "${branchName}" across ${paths.length} repo(s).`);

	for (const repoPath of paths) {
		let axonChild: ReturnType<typeof startAxonWatch> = null;
		try {
			console.log(chalk.bold(`\nPreparing ${repoPath} for ${branchName}...`));
			const effectivePath = await prepareRepoForWork(repoPath, branchName, false, undefined, customBaseBranchOverride ?? undefined);

			if (preApprovedPlan && approvedTodoItems.length > 0) {
				const todoPath = todoFilePath(effectivePath, branchName);
				const todoContent = [
					`# Custom Task: ${taskDescription.slice(0, 80)}`,
					'',
					...approvedTodoItems.map((item) => `- [ ] ${item}`),
					'',
				].join('\n');
				await fs.writeFile(todoPath, todoContent, 'utf8');
				console.log(chalk.green(`  ✓ Pre-approved plan written to ${path.basename(todoPath)}`));
			}

			const repoContributing = repoPath === paths[0] ? contributing : await readContributing(effectivePath);
			const axonHint = getAxonPromptHint(effectivePath);
			logAxonStatus(effectivePath);
			axonChild = startAxonWatch(effectivePath);

			const prompt = buildCustomTaskPrompt(taskDescription, branchName, repoContributing ?? '', axonHint, clarifications, preApprovedPlan);

			console.log(chalk.bold(`\nRunning ${agentOption.label} in ${effectivePath}...`));
			await dispatchAgent(agentOption, prompt, effectivePath, '');

			console.log(chalk.green(`\n  ✓ ${agentOption.label} finished in ${effectivePath}.`));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(chalk.red(`  ✗ Agent failed in ${repoPath}: ${message}`));
			await notifySlackStatus(`ForgePilot error for custom task "${branchName}" in ${repoPath}: ${message}`);
			throw error;
		} finally {
			stopAxonWatch(axonChild);
		}
	}

	await notifySlackStatus(`ForgePilot completed ${agentOption.label} for custom task "${branchName}" successfully.`);
}

export async function cleanupWorktrees(statuses: TicketRunStatus[]): Promise<void> {
	for (const s of statuses) {
		if (!s.worktreePaths?.length) continue;
		for (const wtPath of s.worktreePaths) {
			const originalRepo = s.repos[0];
			if (originalRepo) await removeWorktree(originalRepo, wtPath);
		}
	}
}
