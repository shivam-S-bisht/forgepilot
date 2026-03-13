import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getAxonPromptHint, logAxonStatus, startAxonWatch, stopAxonWatch } from '../tools/axon/axon.js';
import { clearCached, getCached, setCached } from './cache.js';
import { fetchFigmaDesignContext } from '../tools/figma/figma.js';
import { fetchUnresolvedReviewComments, findOpenPullRequest, prepareRepoForWork, readContributing, removeWorktree } from '../tools/git/git.js';
import type { OpenPR, ReviewComment } from '../tools/git/git.js';
import { transitionIssueToInProgress } from '../tools/jira/jira.js';
import { buildWorkPrompt, buildCustomTaskPrompt, getJiraBrowseUrl, getDescriptionText, getAcceptanceCriteria } from '../tools/jira/jira-text.js';
import type { ReviewCommentForPrompt } from '../tools/jira/jira-text.js';
import { formatClarifications, runPreflightChecks } from './preflight.js';
import { resolveRepoPathsForMultipleTickets } from './repo.js';
import { isSlackFullFlowEnabled, notifySlackStatus } from '../tools/slack/slack.js';
import type { JiraIssueDetail, TicketRunStatus, WorkAgentOption } from './types.js';
import { askUser, askUserChoice } from './ask.js';
import { isVoiceModeActive, printAndSpeak } from '../tools/voice/voice-input.js';

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
	return path.join(repoPath, `.forgepilot-todos-${ticketKey.toUpperCase()}.md`);
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

	return ALL_AGENT_OPTIONS
		.filter((o) => availableSet.has(o.cli))
		.map(({ cli: __, ...option }) => option);
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
	}
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
): Promise<{ approved: string[]; action: 'approve' | 'skip' }> {
	const maxRounds = 5;

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
			return { approved: items, action: 'approve' };
		}

		if (choice === 'skip') {
			return { approved: [], action: 'skip' };
		}

		if (choice === 'modify') {
			const modifications = await askUser(chalk.cyan('  What should be changed? '));
			if (!modifications) continue;

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

	return { approved: items, action: 'approve' };
}

export async function launchAgentForRepos(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<void> {
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

	console.log(chalk.gray('\n  Generating implementation plan...'));
	const planItems = await generateTodoPlan(detail, firstRepoContributing ?? '', clarifications);
	if (planItems) {
		const result = await reviewTodoPlan(planItems, detail, firstRepoContributing ?? '', clarifications);
		if (result.action === 'approve') {
			approvedTodoItems = result.approved;
			preApprovedPlan = true;
		}
	} else {
		console.log(chalk.gray('  Could not generate plan. The agent will create its own.'));
	}

	await transitionIssueToInProgress(detail);
	await notifySlackStatus(`ForgePilot started ${agentOption.label} for ${detail.key} across ${paths.length} repo(s).`);

	for (const repoPath of paths) {
		let axonChild: ReturnType<typeof startAxonWatch> = null;
		try {
			console.log(chalk.bold(`\nPreparing ${repoPath} for ${detail.key}...`));
			const effectivePath = await prepareRepoForWork(repoPath, detail.key, false, detail);

			const ticketTitle = String(detail.fields.summary ?? detail.key);
			const { reviewMode, reviewComments } = await handleReviewDetection(effectivePath, detail.key, ticketTitle);

			let resumeMode = false;
			if (!reviewMode) {
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

	const tasks = details.map(async (detail, i) => {
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

		try {
			const firstRepoContributing = await readContributing(paths[0]);
			const preflight = await runPreflightChecks(detail, !!firstRepoContributing);
			const clarifications = formatClarifications(preflight);
			const refRepoPaths = preflight.referenceRepoPaths.filter((p) => !paths.includes(p));
			const figmaSection = await fetchFigmaDesignContext(detail);
			const jiraUrl = getJiraBrowseUrl(detail);

			await transitionIssueToInProgress(detail);

			for (const repoPath of paths) {
				const useWorktree = resolution.needsWorktree.has(repoPath);
				let axonChild: ReturnType<typeof startAxonWatch> = null;

				try {
					const effectivePath = await prepareRepoForWork(repoPath, detail.key, useWorktree, detail);
					if (useWorktree) worktreePaths.push(effectivePath);

					const ticketTitle = String(detail.fields.summary ?? detail.key);
					const { reviewMode, reviewComments } = await handleReviewDetection(effectivePath, detail.key, ticketTitle);

					let resumeMode = false;
					if (!reviewMode) {
						({ resumeMode } = await handleCheckpointResume(effectivePath, detail.key));
					}

					const contributing =
						repoPath === paths[0] ? firstRepoContributing : await readContributing(effectivePath);
					const axonHint = getAxonPromptHint(effectivePath);
					axonChild = startAxonWatch(effectivePath);

					let priorAnswers = '';
					const maxQaRounds = 5;

					for (let qaRound = 0; qaRound < maxQaRounds; qaRound++) {
						const isResume = resumeMode && qaRound === 0;
						const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint, figmaSection, priorAnswers, isResume, reviewMode && qaRound === 0 ? reviewComments : []);

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
	});

	await Promise.allSettled(tasks);

	return statuses;
}

export async function launchAgentForCustomTask(
	taskDescription: string,
	branchName: string,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<void> {
	const paths = [...repoPaths.values()];
	const contributing = await readContributing(paths[0]);

	if (paths.length > 1) {
		await promptMultiRepoBranchStrategy(paths, branchName);
	}

	await notifySlackStatus(`ForgePilot started ${agentOption.label} for custom task "${branchName}" across ${paths.length} repo(s).`);

	for (const repoPath of paths) {
		let axonChild: ReturnType<typeof startAxonWatch> = null;
		try {
			console.log(chalk.bold(`\nPreparing ${repoPath} for ${branchName}...`));
			const effectivePath = await prepareRepoForWork(repoPath, branchName);

			const repoContributing = repoPath === paths[0] ? contributing : await readContributing(effectivePath);
			const axonHint = getAxonPromptHint(effectivePath);
			logAxonStatus(effectivePath);
			axonChild = startAxonWatch(effectivePath);

			const prompt = buildCustomTaskPrompt(taskDescription, branchName, repoContributing ?? '', axonHint);

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
