import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

export async function gitExec(repoPath: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
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

export async function prepareRepoForWork(repoPath: string, ticketKey: string): Promise<void> {
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

export async function readContributing(repoPath: string): Promise<string> {
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
