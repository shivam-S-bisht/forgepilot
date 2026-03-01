import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { prepareRepoForWork, readContributing } from './git.js';
import { getAxonPromptHint, logAxonStatus } from './axon.js';
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
	detail: JiraIssueDetail,
	repoPath: string,
	contributing: string,
	autonomous: boolean,
	clarifications: string,
	axonHint: string,
): Promise<void> {
	const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint);
	const args = autonomous
		? ['-p', prompt, '--autopilot', '--allow-all-tools', '--allow-all-paths', '--add-dir', repoPath]
		: ['-i', prompt, '--add-dir', repoPath];
	await runCommandInteractive('copilot', args, 'Copilot', repoPath);
}

async function runRovoForTicket(
	detail: JiraIssueDetail,
	repoPath: string,
	contributing: string,
	clarifications: string,
	axonHint: string,
): Promise<void> {
	const jiraUrl = getJiraBrowseUrl(detail);
	const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint);
	const args = ['rovodev', 'run', '--yolo', '--jira', jiraUrl, prompt];
	await runCommandInteractive('acli', args, 'Rovo', repoPath);
}

async function runCursorForTicket(
	detail: JiraIssueDetail,
	repoPath: string,
	contributing: string,
	clarifications: string,
	axonHint: string,
): Promise<void> {
	const prompt = buildWorkPrompt(detail, contributing, clarifications, axonHint);
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

			console.log(chalk.bold(`\nRunning ${agentOption.label} in ${repoPath} ...`));
			switch (agentOption.id) {
				case 'copilot-autonomous':
					await runCopilotForTicket(detail, repoPath, contributing, true, clarifications, axonHint);
					break;
				case 'copilot-interactive':
					await runCopilotForTicket(detail, repoPath, contributing, false, clarifications, axonHint);
					break;
				case 'rovo-autonomous':
					await runRovoForTicket(detail, repoPath, contributing, clarifications, axonHint);
					break;
				case 'cursor-autonomous':
					await runCursorForTicket(detail, repoPath, contributing, clarifications, axonHint);
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
