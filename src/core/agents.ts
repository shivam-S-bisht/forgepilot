import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { open as fsOpen } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getAxonPromptHint, logAxonStatus, startAxonWatch, stopAxonWatch } from '../tools/axon/axon.js';
import { clearCached, getCached, setCached } from './cache.js';
import { fetchFigmaDesignContext } from '../tools/figma/figma.js';
import { extractBaseBranchOverride, fetchUnresolvedReviewComments, findOpenPullRequest, prepareRepoForWork, readContributing, removeWorktree, createSubAgentWorktree, mergeSubAgentBranches, cleanupSubAgentWorktrees, cleanupForgepilotTempFiles, generateCompletionSummary, formatCompletionSummaryText, buildSummaryPrompt } from '../tools/git/git.js';
import type { TicketCompletionSummary } from '../tools/git/git.js';
import type { OpenPR, ReviewComment, SubAgentBranchAnalysis } from '../tools/git/git.js';
import { transitionIssueToInProgress, addJiraComment } from '../tools/jira/jira.js';
import { buildWorkPrompt, buildCustomTaskPrompt, buildSubTaskPrompt, buildSpikePrompt, buildFollowUpPrompt, getJiraBrowseUrl, getDescriptionText, getAcceptanceCriteria, commentsText, getIssueTypeName } from '../tools/jira/jira-text.js';
import type { ReviewCommentForPrompt } from '../tools/jira/jira-text.js';
import { formatClarifications, runPreflightChecks } from './preflight.js';
import { resolveRepoPathsForMultipleTickets } from './repo.js';
import { isSlackFullFlowEnabled, notifySlackStatus } from '../tools/slack/slack.js';
import type { JiraIssueDetail, TicketRunStatus, WorkAgentOption } from './types.js';
import { ensureLogDirs, getLogFilePath, registerJob, updateJob } from './job-manager.js';
import type { JobRecord } from './job-manager.js';
import { askUser, askUserChoice } from './ask.js';
import { isVoiceModeActive, printAndSpeak } from '../tools/voice/voice-input.js';
import { renderSubAgentDashboard, renderSubAgentLogViewer, clearScreen } from './ui.js';
import type { SubAgentEntry } from './ui.js';
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

// ---------------------------------------------------------------------------
// Background child-process tracking — kill sub-agents when parent exits
// ---------------------------------------------------------------------------
const _bgChildPids = new Set<number>();

function trackBackgroundPid(pid: number): void {
	_bgChildPids.add(pid);
}

function untrackBackgroundPid(pid: number): void {
	_bgChildPids.delete(pid);
}

function killTrackedChildren(): void {
	for (const pid of _bgChildPids) {
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			// Process already exited
		}
	}
	_bgChildPids.clear();
}

function _onExit(): void {
	killTrackedChildren();
}

// Register once — subsequent imports are no-ops because listeners are deduped by reference.
process.on('exit', _onExit);
process.on('SIGINT', () => { killTrackedChildren(); process.exit(130); });
process.on('SIGTERM', () => { killTrackedChildren(); process.exit(143); });
process.on('SIGHUP', () => { killTrackedChildren(); process.exit(129); });

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

	if (child.pid) trackBackgroundPid(child.pid);

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
		if (child.pid) untrackBackgroundPid(child.pid);
		await logFd.close();
		await updateJob(ticketKey, {
			status: 'failed',
			error: `${toolName} CLI not found or failed to start`,
			finishedAt: new Date().toISOString(),
		});
	});

	child.on('exit', async (code) => {
		if (child.pid) untrackBackgroundPid(child.pid);
		await logFd.close();
		if (code === 0 && cwd) {
			const resolvedOption = agentOptionId ? resolveAgentOptionById(agentOptionId) : undefined;
			await publishCompletionSummary(ticketKey, [cwd], resolvedOption);
		}
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

type TaskWave = {
	wave: number;
	tasks: string[];
};

async function classifyTaskDependencies(todoItems: string[]): Promise<TaskWave[]> {
	if (todoItems.length <= 1) return [{ wave: 1, tasks: todoItems }];

	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();

	const numberedTasks = todoItems.map((item, i) => `${i + 1}. ${item}`).join('\n');
	const prompt = [
		'You are analyzing task dependencies for parallel execution.',
		'Given a numbered list of tasks, group them into waves where:',
		'- Wave 1: Tasks that can ALL be done independently (no dependencies on each other)',
		'- Wave 2: Tasks that depend on any Wave 1 task completing first',
		'- Wave 3: Tasks that depend on Wave 2, etc.',
		'',
		'Output requirements:',
		'- Return ONLY lines in this exact format: "WAVE <number>: <task numbers comma-separated>"',
		'- Example: "WAVE 1: 1, 3, 5" means tasks 1, 3, and 5 can run in parallel first.',
		'- Example: "WAVE 2: 2, 4" means tasks 2 and 4 depend on wave 1 results.',
		'- Use as FEW waves as possible. Most tasks are usually independent.',
		'- No explanation, no other text.',
		'',
		'Tasks:',
		numberedTasks,
	].join('\n');

	try {
		let stdout = '';
		if (preflightAgent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 }));
		} else if (preflightAgent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '--mode', 'plan', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 }));
		} else {
			return [{ wave: 1, tasks: todoItems }];
		}

		const waves = new Map<number, string[]>();
		for (const line of stdout.split('\n')) {
			const match = line.match(/^WAVE\s+(\d+)\s*:\s*(.+)/i);
			if (!match) continue;
			const waveNum = parseInt(match[1], 10);
			const taskNums = match[2].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 1 && n <= todoItems.length);
			if (taskNums.length === 0) continue;
			const existing = waves.get(waveNum) ?? [];
			for (const num of taskNums) {
				existing.push(todoItems[num - 1]);
			}
			waves.set(waveNum, existing);
		}

		if (waves.size === 0) return [{ wave: 1, tasks: todoItems }];

		// Ensure all tasks are assigned — any unassigned go to the last wave
		const assignedSet = new Set(Array.from(waves.values()).flat());
		const unassigned = todoItems.filter((t) => !assignedSet.has(t));
		if (unassigned.length > 0) {
			const lastWave = Math.max(...waves.keys());
			const existing = waves.get(lastWave) ?? [];
			existing.push(...unassigned);
			waves.set(lastWave, existing);
		}

		const sorted = Array.from(waves.entries())
			.sort(([a], [b]) => a - b)
			.map(([wave, tasks]) => ({ wave, tasks }));

		return sorted;
	} catch {
		return [{ wave: 1, tasks: todoItems }];
	}
}

type SubAgentResult = {
	index: number;
	status: 'done' | 'failed';
	error?: string;
	pid: number;
	logFile: string;
	worktreePath?: string;
	startedAt: number;
	finishedAt: number;
	taskCount: number;
};

async function writeSubAgentTodo(
	worktreePath: string,
	ticketKey: string,
	subIndex: number,
	totalSubAgents: number,
	subItems: string[],
	allItems: string[],
): Promise<void> {
	const safeKey = ticketKey.toUpperCase().replace(/[/\\]/g, '-');
	const todoPath = path.join(worktreePath, `.forgepilot-todos-${safeKey}.md`);
	const lines = [
		`# ${ticketKey} — Sub-agent ${subIndex + 1}/${totalSubAgents}`,
		'',
		'## Your Tasks',
		...subItems.map((item) => `- [ ] ${item}`),
		'',
		'## Other Tasks (handled by other agents — do NOT work on these)',
		...allItems
			.filter((item) => !subItems.includes(item))
			.map((item) => `- [~] ${item}`),
		'',
	];
	await fs.writeFile(todoPath, lines.join('\n'), 'utf8');
}

async function reconcileTodosAfterMerge(
	mainPath: string,
	ticketKey: string,
	groups: string[][],
	subWorktrees: string[],
): Promise<void> {
	const completedSet = new Set<string>();
	const safeKey = ticketKey.toUpperCase().replace(/[/\\]/g, '-');

	for (const wtPath of subWorktrees) {
		const todoPath = path.join(wtPath, `.forgepilot-todos-${safeKey}.md`);
		try {
			const content = await fs.readFile(todoPath, 'utf8');
			for (const line of content.split('\n')) {
				const checkedMatch = line.match(/^-\s*\[x\]\s+(.+)/i);
				if (checkedMatch) completedSet.add(checkedMatch[1].trim());
			}
		} catch { /* worktree may be cleaned up already */ }
	}

	if (completedSet.size === 0) return;

	const allItems = groups.flat();
	const mainTodoPath = path.join(mainPath, `.forgepilot-todos-${safeKey}.md`);
	try {
		const mainContent = await fs.readFile(mainTodoPath, 'utf8');
		const updated = mainContent.split('\n').map((line) => {
			const uncheckedMatch = line.match(/^-\s*\[\s\]\s+(.+)/);
			if (uncheckedMatch && completedSet.has(uncheckedMatch[1].trim())) {
				return line.replace('- [ ]', '- [x]');
			}
			return line;
		}).join('\n');
		await fs.writeFile(mainTodoPath, updated, 'utf8');
		console.log(chalk.green(`  ✓ Updated main todo: ${completedSet.size}/${allItems.length} tasks marked complete`));
	} catch {
		// Main todo doesn't exist yet — create one with statuses
		const lines = [
			`# ${ticketKey}`,
			'',
			...allItems.map((item) => completedSet.has(item) ? `- [x] ${item}` : `- [ ] ${item}`),
			'',
		];
		await fs.writeFile(mainTodoPath, lines.join('\n'), 'utf8');
		console.log(chalk.green(`  ✓ Created main todo: ${completedSet.size}/${allItems.length} tasks marked complete`));
	}
}

async function executeWave(
	waveIndex: number,
	totalWaves: number,
	waveTasks: string[],
	allItems: string[],
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	effectivePath: string,
	jiraUrl: string,
	contributing: string | null,
	clarifications: string,
	axonHint: string,
	figmaSection: string,
	referenceRepoPaths: string[],
): Promise<{ results: SubAgentResult[]; merged: number; conflicts: string[]; branchAnalyses: SubAgentBranchAnalysis[] }> {
	const maxAgents = getParallelSubAgentCount();
	const agentCount = Math.min(maxAgents, waveTasks.length);
	const groups = partitionTodoItems(waveTasks, agentCount);

	const parentBranch = detail.key.toUpperCase();
	const repoPath = effectivePath;

	await ensureLogDirs();

	const subWorktrees: string[] = [];
	const subJobs: Array<{
		index: number;
		child: ReturnType<typeof spawn>;
		logFile: string;
		logFd: Awaited<ReturnType<typeof fsOpen>>;
		items: string[];
		worktreePath: string;
	}> = [];

	const subIndices: number[] = [];

	for (let i = 0; i < groups.length; i++) {
		const subItems = groups[i];
		const subIdx = waveIndex * 100 + i; // unique index across waves
		subIndices.push(subIdx);
		let wtPath: string;
		try {
			wtPath = await createSubAgentWorktree(repoPath, detail.key, subIdx, parentBranch);
		} catch (err: unknown) {
			console.log(chalk.red(`  ✗ Failed to create worktree for agent ${i + 1}: ${err instanceof Error ? err.message : String(err)}`));
			continue;
		}
		subWorktrees.push(wtPath);

		await writeSubAgentTodo(wtPath, detail.key, i, groups.length, subItems, allItems);

		const prompt = buildSubTaskPrompt(
			detail,
			subItems,
			allItems,
			i,
			groups.length,
			contributing ?? undefined,
			clarifications,
			axonHint,
			figmaSection,
		);

		const { command, args, toolName } = resolveAgentCommand(agentOption, prompt, wtPath, jiraUrl, referenceRepoPaths);

		const safeKey = detail.key.replace(/[/\\]/g, '-');
		const logFile = path.join(path.resolve(import.meta.dirname, '..', '.cache', 'logs'), `${safeKey}-w${waveIndex + 1}-a${i + 1}-${Date.now()}.log`);
		const logFd = await fsOpen(logFile, 'w');

		const spawnEnv = agentOption.id === 'ollama-local'
			? { ...process.env, OLLAMA_API_BASE: getOllamaApiBase() }
			: undefined;

		const child = spawn(command, args, {
			stdio: ['ignore', logFd.fd, logFd.fd],
			cwd: wtPath,
			...(spawnEnv ? { env: spawnEnv } : {}),
		});

		console.log(chalk.gray(`    Agent ${i + 1}/${groups.length} (PID ${child.pid}): ${subItems.length} task(s) → ${toolName}`));
		for (const item of subItems) {
			console.log(chalk.gray(`      • ${item}`));
		}

		subJobs.push({ index: i, child, logFile, logFd, items: subItems, worktreePath: wtPath });
	}

	if (subJobs.length === 0) {
		return { results: [], merged: 0, conflicts: [], branchAnalyses: [] };
	}

	// ── Interactive sub-agent monitor ──────────────────────────────────
	const agentEntries: SubAgentEntry[] = subJobs.map((j) => ({
		index: j.index,
		status: 'running' as const,
		taskCount: j.items.length,
		tasks: j.items,
		logFile: j.logFile,
		pid: j.child.pid ?? 0,
	}));

	const finalResults: SubAgentResult[] = [];

	const agentSpawnTime = Date.now();
	const completionPromises = subJobs.map(
		({ index, child, logFile, logFd, worktreePath, items }) =>
			new Promise<SubAgentResult>((resolve) => {
				const spawnedAt = Date.now();
				child.on('error', async (err) => {
					const entry = agentEntries.find((e) => e.index === index);
					if (entry) entry.status = 'failed';
					await logFd.close();
					resolve({ index, status: 'failed', error: err.message, pid: child.pid ?? 0, logFile, worktreePath, startedAt: spawnedAt, finishedAt: Date.now(), taskCount: items.length });
				});
				child.on('exit', async (code) => {
					const entry = agentEntries.find((e) => e.index === index);
					if (entry) entry.status = code === 0 ? 'done' : 'failed';
					await logFd.close();
					if (code === 0) {
						resolve({ index, status: 'done', pid: child.pid ?? 0, logFile, worktreePath, startedAt: spawnedAt, finishedAt: Date.now(), taskCount: items.length });
					} else {
						resolve({ index, status: 'failed', error: `Exited with code ${code ?? 'unknown'}`, pid: child.pid ?? 0, logFile, worktreePath, startedAt: spawnedAt, finishedAt: Date.now(), taskCount: items.length });
					}
				});
			}),
	);

	// Interactive dashboard with keyboard input
	const startTime = Date.now();
	let monitorSelected = 0;
	let viewingLogIndex = -1; // -1 = dashboard view

	const redrawMonitor = async () => {
		const elapsed = Math.round((Date.now() - startTime) / 1000);
		if (viewingLogIndex >= 0) {
			const entry = agentEntries[viewingLogIndex];
			let logLines: string[] = [];
			try {
				const content = await fs.readFile(entry.logFile, 'utf8');
				logLines = content.split('\n');
			} catch { /* no log yet */ }
			renderSubAgentLogViewer(detail.key, entry.index, entry.status, logLines);
		} else {
			renderSubAgentDashboard(detail.key, waveIndex, totalWaves, agentEntries, monitorSelected, elapsed);
		}
	};

	// Set up raw-mode keyboard handling
	const wasRaw = process.stdin.isRaw;
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
	}

	readline.emitKeypressEvents(process.stdin);

	const onKeypress = (_str: string | undefined, key: readline.Key) => {
		if (!key) return;

		if (viewingLogIndex >= 0) {
			// In log viewer — Escape/q goes back to dashboard
			if (key.name === 'q' || key.name === 'escape' || key.name === 'backspace') {
				viewingLogIndex = -1;
				void redrawMonitor();
			}
			return;
		}

		// Dashboard view
		if (key.name === 'up') {
			monitorSelected = monitorSelected === 0 ? agentEntries.length - 1 : monitorSelected - 1;
			void redrawMonitor();
		} else if (key.name === 'down') {
			monitorSelected = monitorSelected === agentEntries.length - 1 ? 0 : monitorSelected + 1;
			void redrawMonitor();
		} else if (key.name === 'return' || key.name === 'enter') {
			viewingLogIndex = monitorSelected;
			void redrawMonitor();
		} else if (key.name === 'q' || key.name === 'escape') {
			// Close monitor — just stay, agents keep running
		}
	};

	process.stdin.on('keypress', onKeypress);

	// Auto-refresh every 2s
	const refreshInterval = setInterval(() => { void redrawMonitor(); }, 2000);

	// Initial draw
	await redrawMonitor();

	// Wait for all agents
	const results = await Promise.allSettled(completionPromises);

	// Cleanup interactive mode
	clearInterval(refreshInterval);
	process.stdin.removeListener('keypress', onKeypress);
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(wasRaw ?? false);
	}

	// Final draw showing all done
	await redrawMonitor();

	for (const r of results) {
		if (r.status === 'fulfilled') {
			finalResults.push(r.value);
		} else {
			finalResults.push({ index: -1, status: 'failed' as const, error: 'Promise rejected', pid: 0, logFile: '', startedAt: agentSpawnTime, finishedAt: Date.now(), taskCount: 0 });
		}
	}

	// Show summary before merge
	clearScreen();
	for (const result of finalResults) {
		const agentNum = result.index + 1;
		if (result.status === 'done') {
			console.log(chalk.green(`    ✓ Agent ${agentNum}/${groups.length} completed`));
		} else {
			console.log(chalk.red(`    ✗ Agent ${agentNum}/${groups.length} failed: ${result.error}`));
		}
	}

	// Merge sub-agent branches back (includes analysis, stashing, and smart merge)
	const { merged, conflicts, branchAnalyses } = await mergeSubAgentBranches(repoPath, detail.key, subIndices, parentBranch);

	// Reconcile todos
	await reconcileTodosAfterMerge(repoPath, detail.key, groups, subWorktrees);

	// Cleanup worktrees
	await cleanupSubAgentWorktrees(repoPath, detail.key, subIndices);

	return { results: finalResults, merged, conflicts, branchAnalyses };
}

/** Best-effort extraction of premium request / token usage from agent log files. */
async function parseAgentUsageFromLog(logFile: string): Promise<{ requests?: number; cost?: string }> {
	try {
		const content = await fs.readFile(logFile, 'utf8');
		const result: { requests?: number; cost?: string } = {};

		// Claude Code: "Total cost: $1.23" or "Cost: $0.45"
		const costMatch = content.match(/(?:total\s+)?cost:\s*\$([0-9.]+)/i);
		if (costMatch) result.cost = `$${costMatch[1]}`;

		// Aider: "Tokens: 12345 sent, 6789 received" → count as 1 request per send/receive pair
		const aiderTokens = content.match(/Tokens:\s*([0-9,]+)\s*sent/i);
		if (aiderTokens) {
			const allSends = content.match(/Tokens:\s*[0-9,]+\s*sent/gi);
			if (allSends) result.requests = allSends.length;
		}

		// Generic: count lines matching common request/turn patterns
		if (!result.requests) {
			// Claude: "Assistant" turn markers
			const assistantTurns = content.match(/^(?:assistant|╭─|> )/gim);
			// Copilot / generic: "Request \d" or "[request]"
			const requestLines = content.match(/\brequest(?:s)?[\s:#]\s*(\d+)/gi);
			if (requestLines && requestLines.length > 0) {
				const nums = requestLines.map((r) => {
					const m = r.match(/(\d+)/);
					return m ? parseInt(m[1], 10) : 0;
				});
				result.requests = Math.max(...nums);
			} else if (assistantTurns) {
				result.requests = assistantTurns.length;
			}
		}

		return result;
	} catch {
		return {};
	}
}

function formatDuration(ms: number): string {
	const totalSec = Math.round(ms / 1000);
	const mins = Math.floor(totalSec / 60);
	const secs = totalSec % 60;
	if (mins === 0) return `${secs}s`;
	return `${mins}m ${secs}s`;
}

function renderExecutionSummary(
	ticketKey: string,
	agentLabel: string,
	waves: number,
	results: SubAgentResult[],
	totalStartTime: number,
	usageData: Map<number, { requests?: number; cost?: string }>,
	mergedCount: number,
	conflictCount: number,
): void {
	const totalElapsed = Date.now() - totalStartTime;

	console.log('');
	console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════════════════════════════╗'));
	console.log(chalk.bold.cyan('  ║') + chalk.bold('  Execution Summary') + chalk.bold.cyan('                                               ║'));
	console.log(chalk.bold.cyan('  ╠══════════════════════════════════════════════════════════════════╣'));
	console.log(chalk.bold.cyan('  ║') + `  Ticket:  ${chalk.white(ticketKey)}`.padEnd(75) + chalk.bold.cyan('║'));
	console.log(chalk.bold.cyan('  ║') + `  Agent:   ${chalk.white(agentLabel)}`.padEnd(75) + chalk.bold.cyan('║'));
	console.log(chalk.bold.cyan('  ║') + `  Waves:   ${chalk.white(String(waves))}`.padEnd(75) + chalk.bold.cyan('║'));
	console.log(chalk.bold.cyan('  ╠══════════════════════════════════════════════════════════════════╣'));

	const doneCount = results.filter((r) => r.status === 'done').length;
	const failedCount = results.filter((r) => r.status === 'failed').length;
	let totalRequests = 0;
	let totalCostNum = 0;
	let hasAnyUsage = false;

	for (const result of results) {
		const duration = formatDuration(result.finishedAt - result.startedAt);
		const statusIcon = result.status === 'done' ? chalk.green('✓') : chalk.red('✗');
		const statusText = result.status === 'done' ? chalk.green('done') : chalk.red('failed');
		const usage = usageData.get(result.index);
		let usageStr = chalk.gray('—');
		if (usage?.requests) {
			usageStr = chalk.yellow(`${usage.requests} req`);
			totalRequests += usage.requests;
			hasAnyUsage = true;
		}
		let costStr = '';
		if (usage?.cost) {
			costStr = chalk.gray(` (${usage.cost})`);
			const num = parseFloat(usage.cost.replace('$', ''));
			if (!isNaN(num)) totalCostNum += num;
		}

		const line = `  ${statusIcon} Agent ${result.index + 1}  ${statusText}  ${chalk.gray(duration)}  ${chalk.gray(`${result.taskCount} tasks`)}  ${usageStr}${costStr}`;
		console.log(chalk.bold.cyan('  ║') + line.padEnd(75) + chalk.bold.cyan('║'));
	}

	console.log(chalk.bold.cyan('  ╠══════════════════════════════════════════════════════════════════╣'));
	console.log(chalk.bold.cyan('  ║') + `  Total agents:     ${chalk.bold.white(String(results.length))}`.padEnd(75) + chalk.bold.cyan('║'));
	console.log(chalk.bold.cyan('  ║') + `  Succeeded:        ${chalk.bold.green(String(doneCount))}`.padEnd(75) + chalk.bold.cyan('║'));
	if (failedCount > 0) {
		console.log(chalk.bold.cyan('  ║') + `  Failed:           ${chalk.bold.red(String(failedCount))}`.padEnd(75) + chalk.bold.cyan('║'));
	}
	console.log(chalk.bold.cyan('  ║') + `  Merged:           ${chalk.bold.white(String(mergedCount))}`.padEnd(75) + chalk.bold.cyan('║'));
	if (conflictCount > 0) {
		console.log(chalk.bold.cyan('  ║') + `  Conflicts:        ${chalk.bold.yellow(String(conflictCount))}`.padEnd(75) + chalk.bold.cyan('║'));
	}
	if (hasAnyUsage) {
		console.log(chalk.bold.cyan('  ║') + `  Premium requests: ${chalk.bold.yellow(String(totalRequests))}`.padEnd(75) + chalk.bold.cyan('║'));
	}
	if (totalCostNum > 0) {
		console.log(chalk.bold.cyan('  ║') + `  Estimated cost:   ${chalk.bold.yellow(`$${totalCostNum.toFixed(2)}`)}`.padEnd(75) + chalk.bold.cyan('║'));
	}
	console.log(chalk.bold.cyan('  ║') + `  Total time:       ${chalk.bold.white(formatDuration(totalElapsed))}`.padEnd(75) + chalk.bold.cyan('║'));
	console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════════════════════════════╝'));
	console.log('');
}

function displayPostMergeAnalysis(
	analyses: SubAgentBranchAnalysis[],
	conflicts: string[],
): void {
	const withUncommitted = analyses.filter((a) => a.hasUncommittedChanges);
	const withUnmergedCommits = analyses.filter((a) => a.exists && !a.alreadyMerged && a.aheadCommits.length > 0 && conflicts.includes(a.subBranch));
	const alreadyMerged = analyses.filter((a) => a.alreadyMerged);

	if (alreadyMerged.length > 0) {
		console.log(chalk.gray(`  ${alreadyMerged.length} branch(es) were already merged — skipped.`));
	}

	if (withUnmergedCommits.length > 0) {
		console.log(chalk.yellow(`\n  ⚠ ${withUnmergedCommits.length} branch(es) have unmerged commits (conflicts prevented merge):`));
		for (const a of withUnmergedCommits) {
			console.log(chalk.yellow(`\n    ${a.subBranch} — ${a.aheadCommits.length} unmerged commit(s):`));
			for (const c of a.aheadCommits.slice(0, 10)) {
				console.log(chalk.gray(`      ${c.hash} ${c.message}`));
			}
			if (a.aheadCommits.length > 10) {
				console.log(chalk.gray(`      ... and ${a.aheadCommits.length - 10} more`));
			}
		}
	}

	if (withUncommitted.length > 0) {
		console.log(chalk.yellow(`\n  ⚠ ${withUncommitted.length} sub-agent(s) left uncommitted changes in their worktrees:`));
		for (const a of withUncommitted) {
			console.log(chalk.yellow(`    ${a.subBranch}:`));
			for (const f of a.uncommittedFiles.slice(0, 8)) {
				console.log(chalk.gray(`      ${f}`));
			}
			if (a.uncommittedFiles.length > 8) {
				console.log(chalk.gray(`      ... and ${a.uncommittedFiles.length - 8} more`));
			}
		}
		console.log(chalk.gray('\n  These changes were not committed by the agent and were not merged.'));
	}
}

async function promptRetryIncomplete(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	conflicts: string[],
	failedResults: SubAgentResult[],
	analyses: SubAgentBranchAnalysis[],
	effectivePath: string,
	jiraUrl: string,
	contributing: string | null,
	clarifications: string,
	axonHint: string,
	figmaSection: string,
	referenceRepoPaths: string[],
): Promise<boolean> {
	const hasConflicts = conflicts.length > 0;
	const hasFailures = failedResults.length > 0;
	const hasUncommitted = analyses.some((a) => a.hasUncommittedChanges);

	if (!hasConflicts && !hasFailures && !hasUncommitted) return false;

	const issues: string[] = [];
	if (hasConflicts) issues.push(`${conflicts.length} merge conflict(s)`);
	if (hasFailures) issues.push(`${failedResults.length} failed agent(s)`);
	if (hasUncommitted) issues.push('uncommitted changes in worktrees');

	console.log(chalk.yellow(`\n  Issues detected: ${issues.join(', ')}`));

	const choice = await askUserChoice(
		'How would you like to proceed?',
		[
			{ id: 'retry', label: 'Re-run ForgePilot on the incomplete/failed work' },
			{ id: 'manual', label: 'I\'ll handle it manually' },
			{ id: 'skip', label: 'Skip — continue without retrying' },
		],
	);

	if (choice === 'retry') {
		// Collect incomplete TODO items from the main branch todo file
		const safeKey = detail.key.toUpperCase().replace(/[/\\]/g, '-');
		const todoPath = path.join(effectivePath, `.forgepilot-todos-${safeKey}.md`);
		let incompleteTasks: string[] = [];
		try {
			const content = await fs.readFile(todoPath, 'utf8');
			for (const line of content.split('\n')) {
				const unchecked = line.match(/^-\s*\[\s\]\s+(.+)/);
				if (unchecked) incompleteTasks.push(unchecked[1].trim());
			}
		} catch { /* no todo file */ }

		if (incompleteTasks.length === 0) {
			console.log(chalk.gray('  No incomplete tasks found in the todo file. Running full retry.'));
			incompleteTasks = analyses
				.filter((a) => conflicts.includes(a.subBranch) || !a.exists)
				.flatMap((a) => a.aheadCommits.map((c) => c.message))
				.filter(Boolean);
		}

		if (incompleteTasks.length === 0) {
			console.log(chalk.yellow('  Could not determine incomplete tasks. Please re-run manually.'));
			return false;
		}

		console.log(chalk.cyan(`\n  Re-running ${incompleteTasks.length} incomplete task(s)...\n`));
		await dispatchParallelSubAgents(
			detail,
			agentOption,
			incompleteTasks,
			effectivePath,
			jiraUrl,
			contributing,
			clarifications,
			axonHint,
			figmaSection,
			referenceRepoPaths,
		);
		return true;
	}

	return false;
}

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
): Promise<{ results: SubAgentResult[]; branchAnalyses: SubAgentBranchAnalysis[]; totalMerged: number; totalConflicts: string[] }> {
	// Step 1: Classify tasks into dependency waves
	console.log(chalk.gray('  Analyzing task dependencies...'));
	const waves = await classifyTaskDependencies(todoItems);

	if (waves.length === 1) {
		console.log(chalk.gray(`  All ${todoItems.length} tasks are independent — running in a single parallel wave.`));
	} else {
		console.log(chalk.cyan(`  📊 Dependency analysis: ${waves.length} wave(s) detected:`));
		for (const wave of waves) {
			console.log(chalk.gray(`    Wave ${wave.wave}: ${wave.tasks.length} task(s)${wave.tasks.length > 1 ? ' (parallel)' : ''}`));
		}
	}

	const allResults: SubAgentResult[] = [];
	const allBranchAnalyses: SubAgentBranchAnalysis[] = [];
	let totalMerged = 0;
	const totalConflicts: string[] = [];
	const totalStartTime = Date.now();

	// Step 2: Execute wave by wave
	for (let w = 0; w < waves.length; w++) {
		const wave = waves[w];

		console.log(chalk.bold.cyan(`\n  ── Wave ${w + 1}/${waves.length}: ${wave.tasks.length} task(s) ──`));

		if (wave.tasks.length === 1) {
			// Single task in wave — still use worktree for isolation
			console.log(chalk.gray(`    Single task — running one agent.`));
		}

		const { results, merged, conflicts, branchAnalyses } = await executeWave(
			w,
			waves.length,
			wave.tasks,
			todoItems,
			detail,
			agentOption,
			effectivePath,
			jiraUrl,
			contributing,
			clarifications,
			axonHint,
			figmaSection,
			referenceRepoPaths,
		);

		allResults.push(...results);
		allBranchAnalyses.push(...branchAnalyses);
		totalMerged += merged;
		totalConflicts.push(...conflicts);

		const doneCount = results.filter((r) => r.status === 'done').length;
		const failedCount = results.filter((r) => r.status === 'failed').length;

		if (conflicts.length > 0) {
			console.log(chalk.yellow(`\n    ⚠ Wave ${w + 1}: ${conflicts.length} merge conflict(s): ${conflicts.join(', ')}`));
		}

		if (doneCount > 0) {
			console.log(chalk.green(`    ✓ Wave ${w + 1} complete: ${doneCount} succeeded, ${failedCount} failed, ${merged} merged`));
		}

		// Next wave will branch off the merged state
	}

	// Parse usage data from agent logs
	const usageData = new Map<number, { requests?: number; cost?: string }>();
	await Promise.all(allResults.map(async (r) => {
		if (r.logFile) {
			const usage = await parseAgentUsageFromLog(r.logFile);
			usageData.set(r.index, usage);
		}
	}));

	// Render execution summary
	clearScreen();
	renderExecutionSummary(
		detail.key,
		agentOption.label,
		waves.length,
		allResults,
		totalStartTime,
		usageData,
		totalMerged,
		totalConflicts.length,
	);

	// Display detailed branch analysis
	displayPostMergeAnalysis(allBranchAnalyses, totalConflicts);

	// Final cleanup: remove all forgepilot temp files from the root repo
	// This is the LAST step — only after all waves, merges, and reconciliation are done
	await cleanupForgepilotTempFiles(effectivePath);

	return { results: allResults, branchAnalyses: allBranchAnalyses, totalMerged, totalConflicts };
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
			({ stdout } = await execFileAsync('cursor', ['agent', '--mode', 'plan', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
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

// ---------------------------------------------------------------------------
// Ticket mode classification — code vs plan (spike) vs manual
// ---------------------------------------------------------------------------

type TicketMode =
	| { mode: 'code' }
	| { mode: 'plan'; reason: string }
	| { mode: 'manual'; reason: string; indicators: string[] };

function classifyTicketMode(detail: JiraIssueDetail): TicketMode {
	const issueTypeName = getIssueTypeName(detail).toLowerCase();
	const title = (detail.fields.summary ?? '').toLowerCase();
	const description = getDescriptionText(detail).toLowerCase();
	const combined = `${title} ${description}`;

	// Spike / research / investigation / epic → plan mode
	const planTypePatterns = ['spike', 'research', 'investigation', 'poc', 'proof of concept', 'discovery', 'epic'];
	for (const pat of planTypePatterns) {
		if (issueTypeName.includes(pat)) {
			const verb = issueTypeName.includes('epic') ? 'high-level planning' : 'research/investigation';
			return { mode: 'plan', reason: `Issue type is "${getIssueTypeName(detail)}" — this is a ${verb} task` };
		}
	}

	// Manual-change issue types
	const manualTypePatterns = ['db change', 'database change', 'db migration', 'infra change', 'infrastructure', 'deployment', 'config change'];
	for (const pat of manualTypePatterns) {
		if (issueTypeName.includes(pat)) {
			return { mode: 'manual', reason: `Issue type is "${getIssueTypeName(detail)}"`, indicators: [getIssueTypeName(detail)] };
		}
	}

	// Detect manual-change signals in ticket content
	const manualChecks: Array<{ pattern: RegExp; label: string }> = [
		{ pattern: /\b(alter\s+table|create\s+table|drop\s+table|add\s+column|drop\s+column|rename\s+table|create\s+index|drop\s+index)\b/i, label: 'Database DDL changes' },
		{ pattern: /\b(database\s+migration|db\s+migration|schema\s+change|schema\s+migration|run\s+migration)\b/i, label: 'Database migration' },
		{ pattern: /\b(terraform|helm\s+chart|kubernetes\s+manifest|k8s\s+(config|deploy)|infra\s+change)\b/i, label: 'Infrastructure change' },
		{ pattern: /\b(manually\s+(run|execute|deploy|configure)|run\s+the\s+following\s+(command|script)|execute\s+the\s+following)\b/i, label: 'Manual execution required' },
		{ pattern: /\b(add|update|change|set|delete|remove)\s+(environment\s+variable|env\s+var|secret|vault\s+secret)\b/i, label: 'Environment variable or secret changes' },
		{ pattern: /\b(data\s+backfill|backfill\s+data|data\s+migration|migrate\s+data|seed\s+data)\b/i, label: 'Data migration or backfill' },
		{ pattern: /\b(feature\s+flag|feature\s+toggle)\s+(enable|disable|turn\s+on|turn\s+off)\b/i, label: 'Feature flag change' },
	];

	const indicators: string[] = [];
	for (const { pattern, label } of manualChecks) {
		if (pattern.test(combined)) {
			indicators.push(label);
		}
	}

	if (indicators.length > 0) {
		return {
			mode: 'manual',
			reason: 'Detected manual changes required based on ticket content',
			indicators,
		};
	}

	return { mode: 'code' };
}

async function generateManualSteps(detail: JiraIssueDetail): Promise<string[]> {
	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();
	const title = detail.fields.summary ?? '(no title)';
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);

	const prompt = [
		'You are a senior software engineer analyzing a Jira ticket that requires manual (non-code) changes.',
		'Extract or generate the specific manual steps a human operator must perform.',
		'',
		'Output requirements:',
		'- Return ONLY a numbered list of steps.',
		'- Format: "1. Step description"',
		'- Be specific: include SQL commands, CLI commands, or config snippets where relevant.',
		'- Include warnings, prerequisites, and rollback notes where appropriate.',
		'- Max 25 steps.',
		'- No prose, no headings — only the numbered list.',
		'',
		`Ticket: ${detail.key}`,
		`Title: ${title}`,
		'',
		`Description:\n${description.slice(0, 6000)}`,
		'',
		`Acceptance Criteria:\n${ac.slice(0, 4000)}`,
	].join('\n');

	try {
		let stdout = '';
		if (preflightAgent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else if (preflightAgent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '--mode', 'plan', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else {
			return [];
		}

		return stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => /^\d+\./.test(line))
			.map((line) => line.replace(/^\d+\.\s*/, '').trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function generateSpikeResearchPlan(detail: JiraIssueDetail, contributing: string, clarifications: string): Promise<string[]> {
	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();
	const title = detail.fields.summary ?? '(no title)';
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);

	const prompt = [
		'You are a senior software engineer planning a technical spike / research investigation.',
		'Generate a list of research areas or investigation tasks to complete this spike.',
		'',
		'Output requirements:',
		'- Return ONLY a markdown checklist (no explanation, no JSON, no code fences).',
		'- Format: "- [ ] Research area or investigation task"',
		'- Focus on: understanding current state, exploring options, identifying risks, making recommendations.',
		'- Max 12 items.',
		'',
		`Ticket: ${detail.key}`,
		`Title: ${title}`,
		'',
		`Description:\n${description.slice(0, 6000)}`,
		'',
		`Acceptance Criteria / Goals:\n${ac.slice(0, 4000)}`,
		contributing ? `\nContributing Guidelines:\n${contributing.slice(0, 2000)}` : '',
		clarifications ? `\nUser Clarifications:\n${clarifications.slice(0, 2000)}` : '',
	].filter(Boolean).join('\n');

	try {
		let stdout = '';
		if (preflightAgent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else if (preflightAgent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '--mode', 'plan', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
		} else {
			return [];
		}

		return stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('- [ ]'))
			.map((line) => line.replace(/^- \[ \]\s*/, '').trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function displayManualSteps(detail: JiraIssueDetail, reason: string, indicators: string[], steps: string[]): void {
	const issueType = getIssueTypeName(detail) || 'Ticket';
	console.log(chalk.bold.yellow(`\n  ⚠  Manual Changes Required — ${detail.key}`));
	console.log(chalk.yellow(`  This ${issueType} requires manual changes that cannot be automated.\n`));
	console.log(chalk.gray(`  Reason: ${reason}`));
	if (indicators.length > 0) {
		console.log(chalk.gray(`  Detected: ${indicators.join(', ')}`));
	}
	console.log('');

	if (steps.length > 0) {
		console.log(chalk.bold.white('  Steps to perform manually:\n'));
		for (let i = 0; i < steps.length; i++) {
			console.log(chalk.white(`  ${i + 1}. ${steps[i]}`));
		}
	} else {
		console.log(chalk.gray('  Review the ticket description for the specific manual steps required.'));
	}
	console.log('');
}

const APPROVAL_PHRASES = /^\s*(looks\s*good|(?:it(?:'s|\s+is)\s+)?(?:good|fine|ok(?:ay)?|perfect|great|nice|correct|lgtm|approve|no\s*change[s]?|nothing|none|nope|nah|all\s*good|that(?:'s|\s+is)\s*(?:good|fine|it|all)))\s*[.!]?\s*$/i;

function looksLikeApproval(text: string): boolean {
	return !text.trim() || APPROVAL_PHRASES.test(text);
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
			const freeText = choice.slice('__unmatched__:'.length);
			if (looksLikeApproval(freeText)) {
				console.log(chalk.green('  ✓ Approving current plan.'));
				return { approved: items, action: 'approve', lastModifications };
			}
			lastModifications = freeText;
			console.log(chalk.gray('  Treating your response as a plan modification...'));
			if (isVoiceModeActive()) {
				printAndSpeak('Updating the plan with your feedback.');
			}
			const updated = await generateTodoPlan(detail, contributing, clarifications, freeText);
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
			if (!modifications || looksLikeApproval(modifications)) {
				console.log(chalk.green('  ✓ No changes — keeping current plan.'));
				continue;
			}
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
			({ stdout } = await execFileAsync('cursor', ['agent', '--mode', 'plan', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
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
			const freeText = choice.slice('__unmatched__:'.length);
			if (looksLikeApproval(freeText)) {
				console.log(chalk.green('  ✓ Approving current plan.'));
				return { approved: items, action: 'approve', lastModifications };
			}
			lastModifications = freeText;
			console.log(chalk.gray('  Treating your response as a plan modification...'));
			if (isVoiceModeActive()) {
				printAndSpeak('Updating the plan with your feedback.');
			}
			const updated = await generateCustomTodoPlan(taskDescription, contributing, clarifications, freeText);
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
			if (!modifications || looksLikeApproval(modifications)) {
				console.log(chalk.green('  ✓ No changes — keeping current plan.'));
				continue;
			}
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
			({ stdout } = await execFileAsync('cursor', ['agent', '--mode', 'plan', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 60_000 }));
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

// ---------------------------------------------------------------------------
// Publish a work summary when a ticket completes (Slack + Jira comment)
// ---------------------------------------------------------------------------

async function generateAiSummaryForPaths(
	ticketKey: string,
	effectivePaths: string[],
	agentOption: WorkAgentOption,
): Promise<{ summaries: TicketCompletionSummary[]; text: string }> {
	const summaries = await Promise.all(
		effectivePaths.map((p) => generateCompletionSummary(p, ticketKey)),
	);
	const nonEmpty = summaries.filter((s) => s.commitCount > 0);
	if (nonEmpty.length === 0) return { summaries: nonEmpty, text: '' };

	// Try to generate an AI summary using the same agent that did the work
	const prompt = buildSummaryPrompt(nonEmpty);
	if (prompt) {
		try {
			const { command, args } = resolveAgentCommand(agentOption, prompt, effectivePaths[0], '');
			const { stdout } = await execFileAsync(command, args, {
				cwd: effectivePaths[0],
				maxBuffer: 5 * 1024 * 1024,
				timeout: 90_000,
			});
			const aiText = stdout.trim();
			if (aiText.length > 20) {
				for (const s of nonEmpty) s.aiSummary = aiText;
			}
		} catch {
			// AI summary failed — fall back to raw stats
		}
	}

	return { summaries: nonEmpty, text: formatCompletionSummaryText(nonEmpty) };
}

async function publishCompletionSummary(
	ticketKey: string,
	effectivePaths: string[],
	agentOption?: WorkAgentOption,
): Promise<void> {
	try {
		let text: string;
		if (agentOption) {
			({ text } = await generateAiSummaryForPaths(ticketKey, effectivePaths, agentOption));
		} else {
			const summaries = await Promise.all(
				effectivePaths.map((p) => generateCompletionSummary(p, ticketKey)),
			);
			const nonEmpty = summaries.filter((s) => s.commitCount > 0);
			if (nonEmpty.length === 0) return;
			text = formatCompletionSummaryText(nonEmpty);
		}
		if (!text) return;

		await notifySlackStatus(text);
		await addJiraComment(ticketKey, text).catch(() => {
			// Jira comment is best-effort; don't fail the completion for it.
		});
	} catch {
		// Summary publishing is best-effort.
	}
}

// ---------------------------------------------------------------------------
// Interactive review-and-iterate loop (foreground only)
// ---------------------------------------------------------------------------

async function reviewAndIterateLoop(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	effectivePaths: string[],
	jiraUrl: string,
	referenceRepoPaths: string[],
	contributing?: string,
	clarifications?: string,
): Promise<string> {
	const maxRounds = 10;
	let lastSummaryText = '';

	for (let round = 0; round < maxRounds; round++) {
		// Generate fresh summary
		const { summaries, text } = await generateAiSummaryForPaths(detail.key, effectivePaths, agentOption);
		lastSummaryText = text;

		if (!text || summaries.length === 0) {
			console.log(chalk.gray('\n  No changes detected to summarize.'));
			break;
		}

		// Display summary
		console.log('');
		console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════════════════════════════╗'));
		console.log(chalk.bold.cyan('  ║') + chalk.bold('  Work Summary') + chalk.bold.cyan('                                                    ║'));
		console.log(chalk.bold.cyan('  ╠══════════════════════════════════════════════════════════════════╣'));
		for (const line of text.split('\n')) {
			const padded = `  ${line}`.padEnd(66);
			console.log(chalk.bold.cyan('  ║') + chalk.white(padded) + chalk.bold.cyan('║'));
		}
		console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════════════════════════════╝'));
		console.log('');

		const choice = await askUserChoice(
			'How would you like to proceed?',
			[
				{ id: 'done', label: '✓ Looks good — finish up' },
				{ id: 'more', label: '✏ Add functionality / make changes' },
				{ id: 'diff', label: '📋 Show raw diff stats' },
			],
		);

		if (choice === 'done') {
			break;
		}

		if (choice === 'diff') {
			for (const s of summaries) {
				if (summaries.length > 1) console.log(chalk.bold(`\n  Repo: ${s.repoName}`));
				console.log(chalk.gray(s.diffStat || '  (no diff stats)'));
				if (s.fileList) {
					console.log(chalk.gray('\n  Files changed:'));
					for (const f of s.fileList.split('\n').filter(Boolean)) {
						console.log(chalk.gray(`    ${f}`));
					}
				}
			}
			// Re-show the prompt (don't count as a round)
			round--;
			continue;
		}

		if (choice === 'more') {
			const userRequest = await askUser(chalk.cyan('  What would you like to add or change? '));
			if (!userRequest.trim()) {
				console.log(chalk.yellow('  No input provided. Skipping.'));
				round--;
				continue;
			}

			const aiSummary = summaries[0].aiSummary ?? text;
			const followUpPrompt = buildFollowUpPrompt(detail, aiSummary, userRequest, contributing, clarifications);

			for (const ep of effectivePaths) {
				console.log(chalk.bold(`\n  Re-running ${agentOption.label} in ${ep}...`));
				await dispatchAgent(agentOption, followUpPrompt, ep, jiraUrl, referenceRepoPaths);
			}
		}
	}

	return lastSummaryText;
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

	// Register job early so other terminals see this ticket is active immediately
	await registerJob({
		id: detail.key,
		ticketKey: detail.key,
		title: String(detail.fields.summary ?? detail.key),
		agent: agentOption.label,
		agentOptionId: agentOption.id,
		pid: process.pid,
		logFile: '',
		status: 'running',
		startedAt: new Date().toISOString(),
		repos: paths,
		effectivePaths: [],
	});

	try {

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

	// ── Ticket mode classification ────────────────────────────────────────
	const ticketMode = classifyTicketMode(detail);
	const issueTypeLabel = getIssueTypeName(detail) || 'Ticket';

	if (ticketMode.mode === 'manual') {
		console.log(chalk.gray('\n  Analyzing ticket for manual steps...'));
		const steps = await generateManualSteps(detail);
		displayManualSteps(detail, ticketMode.reason, ticketMode.indicators, steps);

		const manualChoice = await askUserChoice(
			`${detail.key} requires manual changes. How would you like to proceed?`,
			[
				{ id: 'stop', label: 'Stop here — I will perform the manual steps myself' },
				{ id: 'proceed', label: 'Proceed anyway — have the agent attempt this ticket' },
			],
		);

		if (manualChoice === 'stop') {
			console.log(chalk.cyan('\n  Perform the manual steps listed above in your environment.'));
			console.log(chalk.cyan(`  Remember to update the status of ${detail.key} in Jira once complete.`));
			await updateJob(detail.key, { status: 'stopped', finishedAt: new Date().toISOString() });
			return;
		}
		console.log(chalk.yellow('\n  Proceeding with coding agent despite detected manual requirements...\n'));
	}

	if (ticketMode.mode === 'plan') {
		console.log(chalk.bold.cyan(`\n  📋 Plan Mode — ${issueTypeLabel}: ${detail.key}`));
		console.log(chalk.gray(`  ${ticketMode.reason}\n`));

		console.log(chalk.gray('  Generating research/investigation plan...'));
		let researchItems = await generateSpikeResearchPlan(detail, firstRepoContributing ?? '', clarifications);

		if (researchItems.length === 0) {
			console.log(chalk.yellow('  Could not auto-generate research plan. Agent will explore freely.'));
		}

		let planApproved = false;
		const maxPlanRounds = 5;
		for (let round = 0; round < maxPlanRounds && !planApproved; round++) {
			console.log(chalk.bold.cyan(`\n  Research plan for ${detail.key}:\n`));
			if (researchItems.length > 0) {
				for (let i = 0; i < researchItems.length; i++) {
					console.log(chalk.white(`  ${i + 1}. ${researchItems[i]}`));
				}
			} else {
				console.log(chalk.gray('  (no specific research items — agent will explore freely)'));
			}
			console.log('');

			const planChoice = await askUserChoice('What would you like to do?', [
				{ id: 'approve', label: 'Looks good — start the spike investigation' },
				{ id: 'modify', label: 'Modify the research plan' },
				{ id: 'skip', label: 'Skip plan review — let the agent decide' },
			]);

			if (planChoice === 'approve' || planChoice === 'skip') {
				planApproved = true;
			} else if (planChoice === 'modify') {
				const mod = await askUser(chalk.cyan('  What should be changed? '));
				if (mod) {
					const updated = await generateSpikeResearchPlan(detail, firstRepoContributing ?? '', `${clarifications}\n${mod}`);
					if (updated.length > 0) researchItems = updated;
					else console.log(chalk.yellow('  Could not regenerate. Keeping current plan.'));
				}
			}
		}

		await transitionIssueToInProgress(detail);
		await notifySlackStatus(`ForgePilot started ${agentOption.label} for spike ${detail.key}.`);

		for (const repoPath of paths) {
			let axonChild: ReturnType<typeof startAxonWatch> = null;
			try {
				console.log(chalk.bold(`\nPreparing ${repoPath} for spike ${detail.key}...`));
				const effectivePath = await prepareRepoForWork(repoPath, detail.key, false, detail);
				const repoContributing = repoPath === paths[0] ? firstRepoContributing : await readContributing(effectivePath);
				logAxonStatus(effectivePath);
				axonChild = startAxonWatch(effectivePath);
				const spikePrompt = buildSpikePrompt(detail, repoContributing ?? '', clarifications, researchItems);
				console.log(chalk.bold(`\nRunning ${agentOption.label} in spike/plan mode in ${effectivePath}...`));
				await dispatchAgent(agentOption, spikePrompt, effectivePath, jiraUrl, referenceRepoPaths);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await notifySlackStatus(`ForgePilot error for spike ${detail.key}: ${message}.`);
				throw error;
			} finally {
				stopAxonWatch(axonChild);
			}
		}

		const spikeSummary = await reviewAndIterateLoop(
			detail,
			agentOption,
			paths,
			jiraUrl,
			referenceRepoPaths,
			firstRepoContributing ?? undefined,
			clarifications,
		);
		if (spikeSummary) {
			await notifySlackStatus(spikeSummary);
			await addJiraComment(detail.key, spikeSummary).catch(() => {});
		}
		await notifySlackStatus(`ForgePilot completed spike investigation for ${detail.key}.`);
		await updateJob(detail.key, { status: 'done', finishedAt: new Date().toISOString() });
		return;
	}

	// ── Code mode: fall through to normal plan/implement flow ─────────────
	void issueTypeLabel; // used in manual/plan branches above

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

	const completedEffectivePaths: string[] = [];

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
				const { results: subResults, branchAnalyses, totalConflicts } = await dispatchParallelSubAgents(
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

				// Ask user about retrying incomplete work (foreground only)
				await promptRetryIncomplete(
					detail,
					agentOption,
					totalConflicts,
					failedSubs,
					branchAnalyses,
					effectivePath,
					jiraUrl,
					contributing,
					clarifications,
					axonHint,
					figmaSection,
					referenceRepoPaths,
				);

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
			completedEffectivePaths.push(effectivePath);
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

	// Interactive review-and-iterate loop — show AI summary, let user request more work
	const finalSummary = await reviewAndIterateLoop(
		detail,
		agentOption,
		completedEffectivePaths,
		jiraUrl,
		referenceRepoPaths,
		firstRepoContributing ?? undefined,
		clarifications,
	);

	// Publish the final summary to Slack + Jira
	if (finalSummary) {
		await notifySlackStatus(finalSummary);
		await addJiraComment(detail.key, finalSummary).catch(() => {});
	}
	await notifySlackStatus(`ForgePilot completed ${agentOption.label} for ${detail.key} successfully.`);

	await updateJob(detail.key, {
		status: 'done',
		finishedAt: new Date().toISOString(),
	});

	} catch (error) {
		await updateJob(detail.key, {
			status: 'failed',
			error: error instanceof Error ? error.message : String(error),
			finishedAt: new Date().toISOString(),
		});
		throw error;
	}
}

export async function launchAgentInBackground(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<JobRecord> {
	const paths = [...repoPaths.values()];

	// Register job early so other terminals see this ticket is active immediately
	await registerJob({
		id: detail.key,
		ticketKey: detail.key,
		title: String(detail.fields.summary ?? detail.key),
		agent: agentOption.label,
		agentOptionId: agentOption.id,
		pid: process.pid,
		logFile: '',
		status: 'running',
		startedAt: new Date().toISOString(),
		repos: paths,
		effectivePaths: [],
	});

	try {

	const firstRepoContributing = await readContributing(paths[0]);
	const preflight = await runPreflightChecks(detail, !!firstRepoContributing);
	const clarifications = formatClarifications(preflight);
	const referenceRepoPaths = preflight.referenceRepoPaths.filter((p) => !paths.includes(p));

	const figmaSection = await fetchFigmaDesignContext(detail);
	const jiraUrl = getJiraBrowseUrl(detail);

	// ── Ticket mode classification ────────────────────────────────────────
	const bgTicketMode = classifyTicketMode(detail);
	const bgIssueTypeLabel = getIssueTypeName(detail) || 'Ticket';

	if (bgTicketMode.mode === 'manual') {
		console.log(chalk.gray('\n  Analyzing ticket for manual steps...'));
		const steps = await generateManualSteps(detail);
		displayManualSteps(detail, bgTicketMode.reason, bgTicketMode.indicators, steps);

		const manualChoice = await askUserChoice(
			`${detail.key} requires manual changes. How would you like to proceed?`,
			[
				{ id: 'stop', label: 'Stop here — I will perform the manual steps myself' },
				{ id: 'proceed', label: 'Proceed anyway — have the agent attempt this ticket' },
			],
		);

		if (manualChoice === 'stop') {
			console.log(chalk.cyan('\n  Perform the manual steps listed above in your environment.'));
			console.log(chalk.cyan(`  Remember to update the status of ${detail.key} in Jira once complete.`));
			throw new Error(`Manual changes required for ${detail.key} — stopped by user.`);
		}
		console.log(chalk.yellow('\n  Proceeding with coding agent despite detected manual requirements...\n'));
	}

	if (bgTicketMode.mode === 'plan') {
		console.log(chalk.bold.cyan(`\n  📋 Plan Mode — ${bgIssueTypeLabel}: ${detail.key}`));
		console.log(chalk.gray(`  ${bgTicketMode.reason}\n`));

		console.log(chalk.gray('  Generating research/investigation plan...'));
		let researchItems = await generateSpikeResearchPlan(detail, firstRepoContributing ?? '', clarifications);
		if (researchItems.length === 0) {
			console.log(chalk.yellow('  Could not auto-generate research plan. Agent will explore freely.'));
		}

		let planApproved = false;
		const maxPlanRounds = 5;
		for (let round = 0; round < maxPlanRounds && !planApproved; round++) {
			console.log(chalk.bold.cyan(`\n  Research plan for ${detail.key}:\n`));
			if (researchItems.length > 0) {
				for (let i = 0; i < researchItems.length; i++) {
					console.log(chalk.white(`  ${i + 1}. ${researchItems[i]}`));
				}
			} else {
				console.log(chalk.gray('  (no research items — agent will explore freely)'));
			}
			console.log('');

			const planChoice = await askUserChoice('What would you like to do?', [
				{ id: 'approve', label: 'Looks good — start the spike investigation' },
				{ id: 'modify', label: 'Modify the research plan' },
				{ id: 'skip', label: 'Skip plan review — let the agent decide' },
			]);

			if (planChoice === 'approve' || planChoice === 'skip') {
				planApproved = true;
			} else if (planChoice === 'modify') {
				const mod = await askUser(chalk.cyan('  What should be changed? '));
				if (mod) {
					const updated = await generateSpikeResearchPlan(detail, firstRepoContributing ?? '', `${clarifications}\n${mod}`);
					if (updated.length > 0) researchItems = updated;
					else console.log(chalk.yellow('  Could not regenerate. Keeping current plan.'));
				}
			}
		}

		await transitionIssueToInProgress(detail);

		const repoPath = paths[0];
		const effectivePath = await prepareRepoForWork(repoPath, detail.key, false, detail);
		const repoContributing = await readContributing(effectivePath);
		const spikePrompt = buildSpikePrompt(detail, repoContributing ?? '', clarifications, researchItems);

		const { command, args, toolName } = resolveAgentCommand(agentOption, spikePrompt, effectivePath, jiraUrl, referenceRepoPaths);
		const job = await runCommandBackground(command, args, toolName, detail.key, String(detail.fields.summary ?? detail.key), paths, effectivePath, agentOption.id);

		await notifySlackStatus(`ForgePilot queued ${agentOption.label} for spike ${detail.key} (background).`);
		return job;
	}

	// ── Code mode: fall through to normal plan/implement flow ─────────────
	void bgIssueTypeLabel; // used in manual/plan branches above

	let preApprovedPlan = false;
	let approvedTodoItems: string[] = [];
	let existingPlanContinue = false;
	let userModifications: string | undefined;
	let planReviewModifications: string | undefined;

	const existingPlanBg = await handleExistingPlan(detail.key, paths);
	if (existingPlanBg.choice === 'continue') {
		existingPlanContinue = true;
	} else {
		const modifications = existingPlanBg.choice === 'modify'
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

	// --- Parallel sub-agent foreground path (waits for completion) ---
	if (useParallelSubAgents && preApprovedPlan && !resumeMode && !reviewMode && approvedTodoItems.length >= 2) {
		let effectiveOption = agentOption;
		if (agentOption.id === 'ollama-local') {
			await ensureOllamaServing();
			const model = await pickOllamaModel();
			if (!model) throw new Error('No Ollama model selected.');
			effectiveOption = { ...agentOption, ollamaModel: model } as WorkAgentOption & { ollamaModel: string };
		}

		const { results: subResults, totalConflicts, branchAnalyses } = await dispatchParallelSubAgents(
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

		const doneCount = subResults.filter((r) => r.status === 'done').length;
		const failedCount = subResults.filter((r) => r.status === 'failed').length;
		const hasIncomplete = totalConflicts.length > 0 || failedCount > 0 || branchAnalyses.some((a) => a.hasUncommittedChanges);

		await publishCompletionSummary(detail.key, [effectivePath], effectiveOption);
		await notifySlackStatus(
			`ForgePilot parallel execution for ${detail.key}: ${doneCount} succeeded, ${failedCount} failed.${hasIncomplete ? ' Some work may be incomplete — review needed.' : ''}`,
		);

		// Register a summary job so the ticket list shows completion status
		const summaryJob: JobRecord = {
			id: detail.key,
			ticketKey: detail.key,
			title: ticketTitle,
			agent: effectiveOption.label,
			agentOptionId: effectiveOption.id,
			pid: process.pid,
			logFile: '',
			status: failedCount === 0 ? 'done' : 'failed',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			repos: paths,
			effectivePaths: [effectivePath],
		};
		await registerJob(summaryJob);

		return summaryJob;
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

	} catch (error) {
		await updateJob(detail.key, {
			status: 'failed',
			error: error instanceof Error ? error.message : String(error),
			finishedAt: new Date().toISOString(),
		});
		throw error;
	}
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
			const ticketEffPaths = worktreePaths.length > 0 ? worktreePaths : paths;
			const ticketJiraUrl = getJiraBrowseUrl(detail);
			const finalSummary = await reviewAndIterateLoop(
				detail,
				agentOption,
				ticketEffPaths,
				ticketJiraUrl,
				refRepoPaths,
				firstRepoContributing ?? undefined,
				clarifications,
			);
			if (finalSummary) {
				await notifySlackStatus(finalSummary);
				await addJiraComment(detail.key, finalSummary).catch(() => {});
			}
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
