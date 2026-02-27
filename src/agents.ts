import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { prepareRepoForWork, readContributing } from './git.js';
import { buildWorkPrompt, getJiraBrowseUrl } from './jira-text.js';
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
	detail: JiraIssueDetail,
	repoPath: string,
	contributing: string,
	autonomous: boolean,
): Promise<void> {
	const prompt = buildWorkPrompt(detail, contributing);
	const args = autonomous
		? ['-p', prompt, '--autopilot', '--allow-all-tools', '--allow-all-paths', '--add-dir', repoPath]
		: ['-i', prompt, '--add-dir', repoPath];
	await runCommandInteractive('copilot', args, 'Copilot', repoPath);
}

async function runRovoForTicket(
	detail: JiraIssueDetail,
	repoPath: string,
	contributing: string,
): Promise<void> {
	const jiraUrl = getJiraBrowseUrl(detail);
	const prompt = buildWorkPrompt(detail, contributing);
	const args = ['rovodev', 'run', '--yolo', '--jira', jiraUrl, prompt];
	await runCommandInteractive('acli', args, 'Rovo', repoPath);
}

async function runCursorForTicket(
	detail: JiraIssueDetail,
	repoPath: string,
	contributing: string,
): Promise<void> {
	const prompt = buildWorkPrompt(detail, contributing);
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
