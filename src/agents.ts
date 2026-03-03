import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { getAxonPromptHint, logAxonStatus } from './axon.js';
import { fetchFigmaDesignContext } from './figma.js';
import { prepareRepoForWork, readContributing } from './git.js';
import { transitionIssueToInProgress } from './jira.js';
import { buildWorkPrompt, getJiraBrowseUrl } from './jira-text.js';
import { formatClarifications, runPreflightChecks } from './preflight.js';
import { notifySlackStatus } from './slack.js';
import type { JiraIssueDetail, WorkAgentOption } from './types.js';

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

async function runCursorForTicket(
	prompt: string,
	repoPath: string,
): Promise<void> {
	const args = ['agent', '--yolo', '--workspace', repoPath, '-p', prompt];
	await runCommandInteractive('cursor', args, 'Cursor Agent', repoPath);
}

export function getWorkAgentOptions(): WorkAgentOption[] {
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
		try {
			console.log(chalk.bold(`\nPreparing ${repoPath} for ${detail.key}...`));
			await prepareRepoForWork(repoPath, detail.key);

			const contributing = repoPath === paths[0] ? firstRepoContributing : await readContributing(repoPath);
			if (contributing) {
				console.log(chalk.gray(`  Found CONTRIBUTING.md / AGENTS.md in ${repoPath}`));
			}

			const axonHint = getAxonPromptHint(repoPath);
			logAxonStatus(repoPath);

			const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint, figmaSection);
			console.log(chalk.bold(`\nRunning ${agentOption.label} in ${repoPath} ...`));
			switch (agentOption.id) {
				case 'copilot-autonomous':
					await runCopilotForTicket(prompt, repoPath, true);
					break;
				case 'copilot-interactive':
					await runCopilotForTicket(prompt, repoPath, false);
					break;
				case 'rovo-autonomous':
					await runRovoForTicket(prompt, repoPath, getJiraBrowseUrl(detail));
					break;
				case 'cursor-autonomous':
					await runCursorForTicket(prompt, repoPath);
					break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await notifySlackStatus(
				`ForgePilot error for ${detail.key} in ${repoPath} using ${agentOption.label}: ${message}`,
			);
			throw error;
		}
	}

	await notifySlackStatus(`ForgePilot completed ${agentOption.label} for ${detail.key} successfully.`);
}
