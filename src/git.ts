import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getCached, setCached } from './cache.js';

const execFileAsync = promisify(execFile);

type BranchStateEntry = {
	ticketKey: string;
	repoPath: string;
	branchName: string;
	existedBefore: boolean;
	action: 'created' | 'reused';
	lastPreparedAt: string;
};

type BranchStateCache = Record<string, BranchStateEntry>;

export async function gitExec(repoPath: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

function getBaseBranch(): string {
	return process.env.FORGEPILOT_BASE_BRANCH?.trim() || 'development';
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
	try {
		await gitExec(repoPath, ['rev-parse', '--verify', branch]);
		return true;
	} catch {
		return false;
	}
}

function getWorktreeBaseDir(): string {
	const custom = process.env.FORGEPILOT_WORKTREE_DIR?.trim();
	if (custom) return custom.replace(/^~/, process.env.HOME ?? '~');
	return path.join(process.env.HOME ?? '/tmp', '.forgepilot-worktrees');
}

export function getWorktreePath(repoPath: string, ticketKey: string): string {
	const repoName = path.basename(repoPath);
	return path.join(getWorktreeBaseDir(), `${repoName}--${ticketKey.toUpperCase()}`);
}

export async function createWorktree(repoPath: string, ticketKey: string): Promise<string> {
	const branchName = ticketKey.toUpperCase();
	const wtPath = getWorktreePath(repoPath, ticketKey);
	const baseBranch = getBaseBranch();

	await fs.mkdir(path.dirname(wtPath), { recursive: true });

	console.log(chalk.gray(`  Fetching latest from remote in ${repoPath}...`));
	try {
		await gitExec(repoPath, ['fetch', '--prune']);
	} catch {
		console.log(chalk.yellow('  Warning: fetch failed, continuing with local state.'));
	}

	if (existsSync(wtPath)) {
		console.log(chalk.gray(`  Worktree ${wtPath} already exists, reusing...`));
		return wtPath;
	}

	const branchAlreadyExists = await branchExists(repoPath, branchName);
	if (branchAlreadyExists) {
		console.log(chalk.gray(`  Creating worktree for existing branch ${branchName}...`));
		await gitExec(repoPath, ['worktree', 'add', wtPath, branchName]);
	} else {
		console.log(chalk.gray(`  Creating worktree with new branch ${branchName} from ${baseBranch}...`));
		await gitExec(repoPath, ['worktree', 'add', '-b', branchName, wtPath, baseBranch]);
	}

	console.log(chalk.green(`  Worktree ready at ${wtPath}`));
	return wtPath;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
	try {
		await gitExec(repoPath, ['worktree', 'remove', worktreePath, '--force']);
		console.log(chalk.gray(`  Removed worktree ${worktreePath}`));
	} catch {
		console.log(chalk.yellow(`  Warning: could not remove worktree ${worktreePath}`));
	}
}

export async function prepareRepoForWork(
	repoPath: string,
	ticketKey: string,
	useWorktree = false,
): Promise<string> {
	if (useWorktree) {
		return createWorktree(repoPath, ticketKey);
	}

	const branchName = ticketKey.toUpperCase();
	const baseBranch = getBaseBranch();

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

	console.log(chalk.gray(`  Checking out base branch ${baseBranch}...`));
	try {
		await gitExec(repoPath, ['checkout', baseBranch]);
		try {
			await gitExec(repoPath, ['pull', '--ff-only']);
			console.log(chalk.gray(`  Pulled latest on ${baseBranch}.`));
		} catch {
			console.log(chalk.yellow(`  Warning: pull --ff-only failed on ${baseBranch}, continuing.`));
		}
	} catch {
		console.log(chalk.yellow(`  Warning: could not checkout ${baseBranch}, using current branch.`));
	}

	const alreadyExists = await branchExists(repoPath, branchName);
	if (alreadyExists) {
		console.log(chalk.gray(`  Branch ${branchName} already exists, checking out...`));
		await gitExec(repoPath, ['checkout', branchName]);
	} else {
		console.log(chalk.gray(`  Creating branch ${branchName} from ${baseBranch}...`));
		await gitExec(repoPath, ['checkout', '-b', branchName]);
	}

	const cacheKey = `branch-state-${ticketKey.toUpperCase()}`;
	const branchState = (await getCached<BranchStateCache>(cacheKey)) ?? {};
	branchState[repoPath] = {
		ticketKey,
		repoPath,
		branchName,
		existedBefore: alreadyExists,
		action: alreadyExists ? 'reused' : 'created',
		lastPreparedAt: new Date().toISOString(),
	};
	await setCached(cacheKey, branchState);

	console.log(chalk.green(`  Ready on branch ${branchName}`));
	return repoPath;
}

async function detectGitPlatform(repoPath: string): Promise<'github' | 'gitlab' | 'unknown'> {
	try {
		const remoteUrl = await gitExec(repoPath, ['remote', 'get-url', 'origin']);
		if (remoteUrl.includes('github.com')) return 'github';
		if (remoteUrl.includes('gitlab')) return 'gitlab';
	} catch {
		// No remote configured.
	}
	return 'unknown';
}

export async function pushBranchAndCreateMR(
	repoPath: string,
	ticketKey: string,
	ticketTitle: string,
	jiraUrl: string,
): Promise<string> {
	const branchName = ticketKey.toUpperCase();
	const baseBranch = getBaseBranch();

	console.log(chalk.gray(`  Pushing ${branchName} to origin...`));
	await gitExec(repoPath, ['push', '-u', 'origin', branchName]);
	console.log(chalk.green(`  Pushed ${branchName} to origin.`));

	let commitLog = '';
	try {
		commitLog = await gitExec(repoPath, ['log', `${baseBranch}..HEAD`, '--oneline']);
	} catch {
		commitLog = await gitExec(repoPath, ['log', '--oneline', '-20']);
	}

	const mrTitle = `${ticketKey.toUpperCase()} ${ticketTitle}`;
	const mrBody = `${commitLog}\n\n${jiraUrl}`;

	const platform = await detectGitPlatform(repoPath);

	if (platform === 'github') {
		console.log(chalk.gray('  Creating GitHub PR...'));
		const result = await execFileAsync(
			'gh',
			['pr', 'create', '--title', mrTitle, '--body', mrBody, '--base', baseBranch, '--head', branchName],
			{ cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
		);
		const prUrl = result.stdout.trim();
		console.log(chalk.green(`  PR created: ${prUrl}`));
		return prUrl;
	}

	if (platform === 'gitlab') {
		console.log(chalk.gray('  Creating GitLab MR...'));
		const result = await execFileAsync(
			'glab',
			['mr', 'create', '--title', mrTitle, '--description', mrBody, '--source-branch', branchName, '--target-branch', baseBranch, '--yes'],
			{ cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
		);
		const mrUrl = result.stdout.trim();
		console.log(chalk.green(`  MR created: ${mrUrl}`));
		return mrUrl;
	}

	console.log(chalk.yellow('  Could not detect GitHub or GitLab. Branch pushed but MR/PR not created.'));
	return '';
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
