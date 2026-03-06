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

type RepoIdentifier = { host: string; owner: string; repo: string };

async function parseRepoIdentifier(repoPath: string): Promise<RepoIdentifier> {
	const remoteUrl = await gitExec(repoPath, ['remote', 'get-url', 'origin']);

	// SSH: git@gitlab.com:org/repo.git
	const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
	if (sshMatch) {
		const [, host, fullPath] = sshMatch;
		const parts = fullPath.split('/');
		const repo = parts.pop()!;
		const owner = parts.join('/');
		return { host, owner, repo };
	}

	// HTTPS: https://github.com/org/repo.git
	const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
	if (httpsMatch) {
		const [, host, fullPath] = httpsMatch;
		const parts = fullPath.split('/');
		const repo = parts.pop()!;
		const owner = parts.join('/');
		return { host, owner, repo };
	}

	throw new Error(`Could not parse remote URL: ${remoteUrl}`);
}

async function createGitHubPR(
	repoId: RepoIdentifier,
	branchName: string,
	baseBranch: string,
	title: string,
	body: string,
): Promise<string> {
	const token = process.env.FORGEPILOT_GITHUB_TOKEN?.trim();
	if (!token) throw new Error('FORGEPILOT_GITHUB_TOKEN not set');

	const response = await fetch(`https://api.github.com/repos/${repoId.owner}/${repoId.repo}/pulls`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ title, body, head: branchName, base: baseBranch }),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`GitHub API error (${response.status}): ${err}`);
	}

	const data = (await response.json()) as { html_url: string };
	return data.html_url;
}

async function createGitLabMR(
	repoId: RepoIdentifier,
	branchName: string,
	baseBranch: string,
	title: string,
	description: string,
): Promise<string> {
	const token = process.env.FORGEPILOT_GITLAB_TOKEN?.trim();
	if (!token) throw new Error('FORGEPILOT_GITLAB_TOKEN not set');

	const projectPath = encodeURIComponent(`${repoId.owner}/${repoId.repo}`);
	const apiBase = `https://${repoId.host}/api/v4`;

	const response = await fetch(`${apiBase}/projects/${projectPath}/merge_requests`, {
		method: 'POST',
		headers: {
			'PRIVATE-TOKEN': token,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			title,
			description,
			source_branch: branchName,
			target_branch: baseBranch,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`GitLab API error (${response.status}): ${err}`);
	}

	const data = (await response.json()) as { web_url: string };
	return data.web_url;
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

// ---------------------------------------------------------------------------
// PR/MR review comment types and helpers
// ---------------------------------------------------------------------------

export type ReviewComment = {
	id: number;
	path: string;
	line: number | null;
	body: string;
	author: string;
	url: string;
};

export type OpenPR = {
	number: number;
	url: string;
	title: string;
	platform: 'github' | 'gitlab';
};

type CachedPR = {
	number: number;
	url: string;
	platform: 'github' | 'gitlab';
};

function prCacheKey(ticketKey: string): string {
	return `pr-${ticketKey.toUpperCase()}`;
}

export async function findOpenPullRequest(repoPath: string, ticketKey: string): Promise<OpenPR | null> {
	const cached = await getCached<CachedPR>(prCacheKey(ticketKey));
	const platform = await detectGitPlatform(repoPath);
	const branchName = ticketKey.toUpperCase();

	if (platform === 'github') {
		const token = process.env.FORGEPILOT_GITHUB_TOKEN?.trim();
		if (!token) return null;

		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const url = new URL(`https://api.github.com/repos/${repoId.owner}/${repoId.repo}/pulls`);
			url.searchParams.set('head', `${repoId.owner}:${branchName}`);
			url.searchParams.set('state', 'open');

			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/vnd.github+json',
				},
			});
			if (!response.ok) return null;

			const pulls = (await response.json()) as Array<{ number: number; html_url: string; title: string }>;
			if (pulls.length > 0) {
				return { number: pulls[0].number, url: pulls[0].html_url, title: pulls[0].title, platform: 'github' };
			}
		} catch {
			// API call failed; fall through.
		}
		return null;
	}

	if (platform === 'gitlab') {
		const token = process.env.FORGEPILOT_GITLAB_TOKEN?.trim();
		if (!token) return null;

		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const projectPath = encodeURIComponent(`${repoId.owner}/${repoId.repo}`);
			const apiBase = `https://${repoId.host}/api/v4`;
			const url = new URL(`${apiBase}/projects/${projectPath}/merge_requests`);
			url.searchParams.set('source_branch', branchName);
			url.searchParams.set('state', 'opened');

			const response = await fetch(url, {
				headers: { 'PRIVATE-TOKEN': token },
			});
			if (!response.ok) return null;

			const mrs = (await response.json()) as Array<{ iid: number; web_url: string; title: string }>;
			if (mrs.length > 0) {
				return { number: mrs[0].iid, url: mrs[0].web_url, title: mrs[0].title, platform: 'gitlab' };
			}
		} catch {
			// API call failed; fall through.
		}
		return null;
	}

	if (cached) {
		return { number: cached.number, url: cached.url, title: '', platform: cached.platform };
	}

	return null;
}

export async function fetchUnresolvedReviewComments(
	repoPath: string,
	pr: OpenPR,
): Promise<ReviewComment[]> {
	if (pr.platform === 'github') {
		const token = process.env.FORGEPILOT_GITHUB_TOKEN?.trim();
		if (!token) return [];

		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const response = await fetch(
				`https://api.github.com/repos/${repoId.owner}/${repoId.repo}/pulls/${pr.number}/comments`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: 'application/vnd.github+json',
					},
				},
			);
			if (!response.ok) return [];

			type GHComment = {
				id: number;
				path?: string;
				line?: number | null;
				original_line?: number | null;
				body?: string;
				user?: { login?: string };
				html_url?: string;
				in_reply_to_id?: number;
			};
			const comments = (await response.json()) as GHComment[];

			const replyIds = new Set(comments.filter((c) => c.in_reply_to_id).map((c) => c.in_reply_to_id));
			const topLevel = comments.filter((c) => !c.in_reply_to_id);
			const unreplied = topLevel.filter((c) => !replyIds.has(c.id));

			return unreplied.map((c) => ({
				id: c.id,
				path: c.path ?? '',
				line: c.line ?? c.original_line ?? null,
				body: (c.body ?? '').trim(),
				author: c.user?.login ?? 'unknown',
				url: c.html_url ?? '',
			})).filter((c) => c.body.length > 0);
		} catch {
			return [];
		}
	}

	if (pr.platform === 'gitlab') {
		const token = process.env.FORGEPILOT_GITLAB_TOKEN?.trim();
		if (!token) return [];

		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const projectPath = encodeURIComponent(`${repoId.owner}/${repoId.repo}`);
			const apiBase = `https://${repoId.host}/api/v4`;
			const response = await fetch(
				`${apiBase}/projects/${projectPath}/merge_requests/${pr.number}/discussions`,
				{
					headers: { 'PRIVATE-TOKEN': token },
				},
			);
			if (!response.ok) return [];

			type GLNote = {
				id: number;
				body?: string;
				author?: { username?: string };
				resolvable?: boolean;
				resolved?: boolean;
				position?: { new_path?: string; new_line?: number | null };
			};
			type GLDiscussion = {
				notes?: GLNote[];
			};
			const discussions = (await response.json()) as GLDiscussion[];

			const results: ReviewComment[] = [];
			for (const disc of discussions) {
				const firstNote = disc.notes?.[0];
				if (!firstNote) continue;
				if (firstNote.resolvable !== true) continue;
				if (firstNote.resolved === true) continue;

				results.push({
					id: firstNote.id,
					path: firstNote.position?.new_path ?? '',
					line: firstNote.position?.new_line ?? null,
					body: (firstNote.body ?? '').trim(),
					author: firstNote.author?.username ?? 'unknown',
					url: '',
				});
			}
			return results.filter((c) => c.body.length > 0);
		} catch {
			return [];
		}
	}

	return [];
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

		// 1. Try gh CLI
		try {
			const result = await execFileAsync(
				'gh',
				['pr', 'create', '--title', mrTitle, '--body', mrBody, '--base', baseBranch, '--head', branchName],
				{ cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
			);
			const prUrl = result.stdout.trim();
			const prNum = parseInt(prUrl.split('/').pop() ?? '', 10);
			if (prNum) await setCached(prCacheKey(ticketKey), { number: prNum, url: prUrl, platform: 'github' });
			console.log(chalk.green(`  PR created: ${prUrl}`));
			return prUrl;
		} catch (err: unknown) {
			if (!isEnoent(err)) throw err;
			console.log(chalk.gray('  gh CLI not found, trying GitHub API...'));
		}

		// 2. Try GitHub API
		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const prUrl = await createGitHubPR(repoId, branchName, baseBranch, mrTitle, mrBody);
			const prNum = parseInt(prUrl.split('/').pop() ?? '', 10);
			if (prNum) await setCached(prCacheKey(ticketKey), { number: prNum, url: prUrl, platform: 'github' });
			console.log(chalk.green(`  PR created via API: ${prUrl}`));
			return prUrl;
		} catch (apiErr: unknown) {
			const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
			console.log(chalk.yellow(`  GitHub API failed: ${msg}`));
		}

		// 3. Fall back to manual URL
		const ghManualUrl = await buildManualMrUrl(repoPath, branchName, baseBranch, 'github');
		console.log(chalk.cyan(`  Create PR manually: ${ghManualUrl}`));
		return ghManualUrl;
	}

	if (platform === 'gitlab') {
		console.log(chalk.gray('  Creating GitLab MR...'));

		// 1. Try glab CLI
		try {
			const result = await execFileAsync(
				'glab',
				['mr', 'create', '--title', mrTitle, '--description', mrBody, '--source-branch', branchName, '--target-branch', baseBranch, '--yes'],
				{ cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
			);
			const mrUrl = result.stdout.trim();
			const mrNum = parseInt(mrUrl.split('/').pop() ?? '', 10);
			if (mrNum) await setCached(prCacheKey(ticketKey), { number: mrNum, url: mrUrl, platform: 'gitlab' });
			console.log(chalk.green(`  MR created: ${mrUrl}`));
			return mrUrl;
		} catch (err: unknown) {
			if (!isEnoent(err)) throw err;
			console.log(chalk.gray('  glab CLI not found, trying GitLab API...'));
		}

		// 2. Try GitLab API
		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const mrUrl = await createGitLabMR(repoId, branchName, baseBranch, mrTitle, mrBody);
			const mrNum = parseInt(mrUrl.split('/').pop() ?? '', 10);
			if (mrNum) await setCached(prCacheKey(ticketKey), { number: mrNum, url: mrUrl, platform: 'gitlab' });
			console.log(chalk.green(`  MR created via API: ${mrUrl}`));
			return mrUrl;
		} catch (apiErr: unknown) {
			const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
			console.log(chalk.yellow(`  GitLab API failed: ${msg}`));
		}

		// 3. Fall back to manual URL
		const glManualUrl = await buildManualMrUrl(repoPath, branchName, baseBranch, 'gitlab');
		console.log(chalk.cyan(`  Create MR manually: ${glManualUrl}`));
		return glManualUrl;
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
