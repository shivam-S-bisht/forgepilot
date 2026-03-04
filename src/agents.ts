import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getAxonPromptHint, logAxonStatus, startAxonWatch, stopAxonWatch } from './axon.js';
import { fetchFigmaDesignContext } from './figma.js';
import { prepareRepoForWork, readContributing } from './git.js';
import { transitionIssueToInProgress } from './jira.js';
import { buildWorkPrompt, getJiraBrowseUrl } from './jira-text.js';
import { formatClarifications, runPreflightChecks } from './preflight.js';
import { notifySlackStatus } from './slack.js';
import type { JiraIssueDetail, WorkAgentOption } from './types.js';

const execFileAsync = promisify(execFile);

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
): Promise<void> {
	const args = autonomous
		? ['-p', prompt, '--autopilot', '--allow-all-tools', '--allow-all-paths', '--add-dir', repoPath]
		: ['-i', prompt, '--add-dir', repoPath];
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

async function runClaudeCodeForTicket(prompt: string, repoPath: string, interactive: boolean): Promise<void> {
	const args = interactive ? [prompt] : ['-p', prompt, '--add-dir', repoPath];
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

export async function launchAgentForRepos(
	detail: JiraIssueDetail,
	agentOption: WorkAgentOption,
	repoPaths: Map<string, string>,
): Promise<void> {
	const paths = [...repoPaths.values()];

	const firstRepoContributing = await readContributing(paths[0]);
	const preflight = await runPreflightChecks(detail, !!firstRepoContributing);
	const clarifications = formatClarifications(preflight);

	const figmaSection = await fetchFigmaDesignContext(detail);

	await transitionIssueToInProgress(detail);
	await notifySlackStatus(`ForgePilot started ${agentOption.label} for ${detail.key} across ${paths.length} repo(s).`);

	for (const repoPath of paths) {
		let axonChild: ReturnType<typeof startAxonWatch> = null;
		try {
			console.log(chalk.bold(`\nPreparing ${repoPath} for ${detail.key}...`));
			await prepareRepoForWork(repoPath, detail.key);

			const contributing = repoPath === paths[0] ? firstRepoContributing : await readContributing(repoPath);
			if (contributing) {
				console.log(chalk.gray(`  Found CONTRIBUTING.md / AGENTS.md in ${repoPath}`));
			}

			const axonHint = getAxonPromptHint(repoPath);
			logAxonStatus(repoPath);
			axonChild = startAxonWatch(repoPath);

			const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint, figmaSection);
			console.log(chalk.bold(`\nRunning ${agentOption.label} in ${repoPath} ...`));
			switch (agentOption.id) {
				case 'copilot-autonomous':
					await runCopilotForTicket(prompt, repoPath, true);
					break;
				case 'copilot-interactive':
					await runCopilotForTicket(prompt, repoPath, false);
					break;
				case 'claude-code-autonomous':
					await runClaudeCodeForTicket(prompt, repoPath, false);
					break;
				case 'claude-code-interactive':
					await runClaudeCodeForTicket(prompt, repoPath, true);
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
					await runRovoForTicket(prompt, repoPath, getJiraBrowseUrl(detail));
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await notifySlackStatus(
				`ForgePilot error for ${detail.key} in ${repoPath} using ${agentOption.label}: ${message}`,
			);
			throw error;
		} finally {
			stopAxonWatch(axonChild);
		}
	}

	await notifySlackStatus(`ForgePilot completed ${agentOption.label} for ${detail.key} successfully.`);
}
