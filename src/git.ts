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
		const axonSource = path.join(repoPath, '.axon');
		const axonTarget = path.join(wtPath, '.axon');
		if (existsSync(axonSource) && !existsSync(axonTarget)) {
			try {
				await fs.symlink(axonSource, axonTarget);
				console.log(chalk.gray('  Symlinked .axon/ into worktree.'));
			} catch {
				// Symlink may already exist or fail silently.
			}
		}
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

	const axonSource = path.join(repoPath, '.axon');
	const axonTarget = path.join(wtPath, '.axon');
	if (existsSync(axonSource) && !existsSync(axonTarget)) {
		try {
			await fs.symlink(axonSource, axonTarget);
			console.log(chalk.gray('  Symlinked .axon/ into worktree.'));
		} catch {
			console.log(chalk.yellow('  Warning: could not symlink .axon/ into worktree.'));
		}
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
		try {
			await gitExec(repoPath, ['checkout', branchName]);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('already used by worktree')) {
				const wtPath = getWorktreePath(repoPath, ticketKey);
				if (existsSync(wtPath)) {
					console.log(chalk.yellow(`  Branch held by existing worktree at ${wtPath}, reusing it.`));
					return wtPath;
				}
				console.log(chalk.yellow('  Stale worktree reference detected, pruning...'));
				await gitExec(repoPath, ['worktree', 'prune']);
				await gitExec(repoPath, ['checkout', branchName]);
			} else {
				throw err;
			}
		}
	} else {
		console.log(chalk.gray(`  Creating branch ${branchName} from ${baseBranch}...`));
		try {
			await gitExec(repoPath, ['checkout', '-b', branchName]);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('already used by worktree')) {
				const wtPath = getWorktreePath(repoPath, ticketKey);
				if (existsSync(wtPath)) {
					console.log(chalk.yellow(`  Branch held by existing worktree at ${wtPath}, reusing it.`));
					return wtPath;
				}
				console.log(chalk.yellow('  Stale worktree reference detected, pruning...'));
				await gitExec(repoPath, ['worktree', 'prune']);
				await gitExec(repoPath, ['checkout', '-b', branchName]);
			} else {
				throw err;
			}
		}
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

function isEnoent(err: unknown): boolean {
	return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function buildManualMrUrl(
	repoPath: string,
	branchName: string,
	baseBranch: string,
	platform: 'github' | 'gitlab',
): Promise<string> {
	const remoteUrl = await gitExec(repoPath, ['remote', 'get-url', 'origin']);
	const httpsUrl = remoteUrl.replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/');
	if (platform === 'github') {
		return `${httpsUrl}/compare/${baseBranch}...${branchName}?expand=1`;
	}
	return `${httpsUrl}/-/merge_requests/new?merge_request[source_branch]=${branchName}&merge_request[target_branch]=${baseBranch}`;
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
		try {
			const result = await execFileAsync(
				'gh',
				['pr', 'create', '--title', mrTitle, '--body', mrBody, '--base', baseBranch, '--head', branchName],
				{ cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
			);
			const prUrl = result.stdout.trim();
			console.log(chalk.green(`  PR created: ${prUrl}`));
			return prUrl;
		} catch (err: unknown) {
			if (isEnoent(err)) {
				console.log(chalk.yellow('  gh CLI not found. Install it with: brew install gh'));
				const manualUrl = await buildManualMrUrl(repoPath, branchName, baseBranch, 'github');
				console.log(chalk.cyan(`  Create PR manually: ${manualUrl}`));
				return manualUrl;
			}
			throw err;
		}
	}

	if (platform === 'gitlab') {
		console.log(chalk.gray('  Creating GitLab MR...'));
		try {
			const result = await execFileAsync(
				'glab',
				['mr', 'create', '--title', mrTitle, '--description', mrBody, '--source-branch', branchName, '--target-branch', baseBranch, '--yes'],
				{ cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
			);
			const mrUrl = result.stdout.trim();
			console.log(chalk.green(`  MR created: ${mrUrl}`));
			return mrUrl;
		} catch (err: unknown) {
			if (isEnoent(err)) {
				console.log(chalk.yellow('  glab CLI not found. Install it with: brew install glab'));
				const manualUrl = await buildManualMrUrl(repoPath, branchName, baseBranch, 'gitlab');
				console.log(chalk.cyan(`  Create MR manually: ${manualUrl}`));
				return manualUrl;
			}
			throw err;
		}
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
