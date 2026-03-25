import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getCached, setCached } from '../../core/cache.js';
import { askUser, askUserChoice } from '../../core/ask.js';
import type { JiraIssueDetail } from '../../core/types.js';

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

export function extractBaseBranchOverride(text: string): string | null {
	if (!text) return null;
	const patterns = [
		/branch\s+off\s+(?:from|of)\s+[`'"]*([^\s`'",.;:]+)[`'"]*/i,
		/branch\s+(?:from|off)\s+[`'"]*([^\s`'",.;:]+)[`'"]*/i,
		/base\s+branch[:\s]+[`'"]*([^\s`'",.;:]+)[`'"]*/i,
		/use\s+[`'"]*([^\s`'",.;:]+)[`'"]*\s+(?:as\s+)?(?:base|branch)/i,
		/create\s+(?:a\s+)?branch\s+from\s+[`'"]*([^\s`'",.;:]+)[`'"]*/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[1]) return match[1];
	}
	return null;
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

export async function createWorktree(repoPath: string, ticketKey: string, baseBranchOverride?: string): Promise<string> {
	const branchName = ticketKey.toUpperCase();
	const wtPath = getWorktreePath(repoPath, ticketKey);
	const baseBranch = baseBranchOverride ?? getBaseBranch();

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

type BugBranchStrategy = {
	baseBranch: string;
	skipNewBranch: boolean;
	useTicketKey: string;
};

function isBugTicket(detail: JiraIssueDetail): boolean {
	const issuetype = detail.fields.issuetype as { name?: string } | undefined;
	const name = issuetype?.name?.toLowerCase() ?? '';
	return name === 'bug' || name === 'defect';
}

function extractLinkedTicketKeys(detail: JiraIssueDetail): string[] {
	const links = detail.fields.issuelinks ?? [];
	const keys: string[] = [];
	for (const link of links) {
		const target = link.outwardIssue ?? link.inwardIssue;
		if (target?.key) keys.push(target.key.toUpperCase());
	}
	return keys;
}

async function resolveBugBranchStrategy(
	repoPath: string,
	detail: JiraIssueDetail,
	ticketKey: string,
): Promise<BugBranchStrategy | null> {
	if (!isBugTicket(detail)) return null;

	const linkedKeys = extractLinkedTicketKeys(detail);
	if (!linkedKeys.length) return null;

	const existingBranches: string[] = [];
	for (const key of linkedKeys) {
		if (await branchExists(repoPath, key)) {
			existingBranches.push(key);
		}
	}

	if (!existingBranches.length) {
		console.log(chalk.gray(`  Bug ticket detected. Linked tickets: ${linkedKeys.join(', ')} — none have local branches.`));
		return null;
	}

	console.log(chalk.bold.yellow(`\n  Bug ticket detected with linked branch(es): ${existingBranches.join(', ')}`));

	const options = [
		...existingBranches.map((b) => ({
			id: `branch-off-${b}`,
			label: `Branch off from ${b} (create new ${ticketKey.toUpperCase()} branch)`,
		})),
		...existingBranches.map((b) => ({
			id: `work-on-${b}`,
			label: `Work directly on ${b} branch (no new branch for this bug)`,
		})),
		{ id: 'default', label: `Use default base branch (${getBaseBranch()})` },
	];

	const choice = await askUserChoice('How should this bug ticket be branched?', options);

	if (choice.startsWith('__unmatched__:')) {
		return null;
	}

	for (const b of existingBranches) {
		if (choice === `branch-off-${b}`) {
			return { baseBranch: b, skipNewBranch: false, useTicketKey: ticketKey };
		}
		if (choice === `work-on-${b}`) {
			return { baseBranch: b, skipNewBranch: true, useTicketKey: b };
		}
	}

	return null;
}

export async function prepareRepoForWork(
	repoPath: string,
	ticketKey: string,
	useWorktree = false,
	detail?: JiraIssueDetail,
	baseBranchOverride?: string,
): Promise<string> {
	if (useWorktree) {
		return createWorktree(repoPath, ticketKey, baseBranchOverride);
	}

	let branchName = ticketKey.toUpperCase();
	let baseBranch = baseBranchOverride ?? getBaseBranch();

	if (detail) {
		const bugStrategy = await resolveBugBranchStrategy(repoPath, detail, ticketKey);
		if (bugStrategy) {
			baseBranch = bugStrategy.baseBranch;
			if (bugStrategy.skipNewBranch) {
				branchName = bugStrategy.useTicketKey;
				console.log(chalk.green(`  ✓ Will work directly on branch ${branchName}`));
			} else {
				console.log(chalk.green(`  ✓ Will create ${branchName} branching off from ${baseBranch}`));
			}
		}
	}

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

type MrConventions = {
	titleFormat?: string;
	descriptionTemplate?: string;
	baseBranch?: string;
};

async function extractMrConventions(repoPath: string, ticketKey: string, ticketTitle: string, commitBullets: string, jiraUrl: string): Promise<MrConventions | null> {
	const contributing = await readContributing(repoPath);
	if (!contributing) return null;

	const agent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();
	const prompt = [
		'You are analyzing a CONTRIBUTING.md / AGENTS.md file to extract MR/PR conventions.',
		'',
		'Given the contributing guidelines below, extract any conventions for:',
		'1. MR/PR title format (e.g., "[TICKET] title", "TICKET: title", "feat(scope): description")',
		'2. MR/PR description template or required sections',
		'3. Target/base branch convention (e.g., "development", "main", "develop")',
		'',
		'Then apply those conventions to generate the actual MR title and description for this ticket.',
		'',
		`Ticket Key: ${ticketKey}`,
		`Ticket Title: ${ticketTitle}`,
		`Jira URL: ${jiraUrl}`,
		`Commits:\n${commitBullets}`,
		'',
		'Output ONLY valid JSON (no markdown fences, no explanation):',
		'{',
		'  "titleFormat": "<the formatted MR title applying the convention>",',
		'  "descriptionTemplate": "<the formatted MR description applying the convention, use \\n for newlines>",',
		'  "baseBranch": "<target branch if specified, or null>"',
		'}',
		'',
		'If the contributing file does not mention MR/PR conventions, return: {"titleFormat":null,"descriptionTemplate":null,"baseBranch":null}',
		'',
		'--- CONTRIBUTING GUIDELINES ---',
		contributing.slice(0, 6000),
		'--- END ---',
	].join('\n');

	try {
		let stdout = '';
		if (agent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 }));
		} else if (agent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 }));
		} else {
			return null;
		}

		const trimmed = stdout.trim();
		const firstBrace = trimmed.indexOf('{');
		const lastBrace = trimmed.lastIndexOf('}');
		if (firstBrace < 0 || lastBrace <= firstBrace) return null;

		const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as MrConventions;
		const hasValues = parsed.titleFormat || parsed.descriptionTemplate || parsed.baseBranch;
		return hasValues ? parsed : null;
	} catch {
		return null;
	}
}

export async function pushBranchAndCreateMR(
	repoPath: string,
	ticketKey: string,
	ticketTitle: string,
	jiraUrl: string,
): Promise<string> {
	const branchName = ticketKey.toUpperCase();
	let baseBranch = getBaseBranch();

	// --- Pre-push review ---
	let diffStat = '';
	try {
		diffStat = await gitExec(repoPath, ['diff', '--stat', `${baseBranch}...HEAD`]);
	} catch {
		try {
			diffStat = await gitExec(repoPath, ['diff', '--stat', 'HEAD~5..HEAD']);
		} catch {
			diffStat = '(could not compute diff stats)';
		}
	}

	let commitLog = '';
	try {
		commitLog = await gitExec(repoPath, ['log', `${baseBranch}..HEAD`, '--oneline']);
	} catch {
		commitLog = await gitExec(repoPath, ['log', '--oneline', '-20']);
	}

	const commitCount = commitLog.split('\n').filter(Boolean).length;

	console.log(chalk.bold.cyan(`\n  Pre-push review for ${branchName}:`));
	console.log(chalk.gray(`  Branch: ${branchName} → ${baseBranch}`));
	console.log(chalk.gray(`  Commits: ${commitCount}`));
	console.log('');
	console.log(chalk.white(diffStat.split('\n').map((l) => `    ${l}`).join('\n')));
	console.log('');

	const pushChoice = await askUserChoice('Do the changes look good?', [
		{ id: 'push', label: 'Yes — push and create MR/PR' },
		{ id: 'cancel', label: 'No — cancel, do not push' },
	]);

	if (pushChoice === 'cancel') {
		console.log(chalk.yellow('  Push cancelled by user.'));
		return '';
	}

	console.log(chalk.gray(`  Pushing ${branchName} to origin...`));
	await gitExec(repoPath, ['push', '-u', 'origin', branchName]);
	console.log(chalk.green(`  ✓ Pushed ${branchName} to origin.`));

	// --- MR/PR preview and edit ---
	const commitBullets = commitLog
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => `- ${line}`)
		.join('\n');

	console.log(chalk.gray('  Checking CONTRIBUTING.md for MR conventions...'));
	const conventions = await extractMrConventions(repoPath, ticketKey, ticketTitle, commitBullets, jiraUrl);

	let mrTitle = `${ticketKey.toUpperCase()} ${ticketTitle}`;
	let mrDescription = `${commitBullets}\n\n${jiraUrl}`;

	if (conventions) {
		console.log(chalk.green('  ✓ MR conventions loaded from CONTRIBUTING.md'));
		if (conventions.titleFormat) {
			mrTitle = conventions.titleFormat;
			console.log(chalk.gray(`    Title format applied: ${mrTitle}`));
		}
		if (conventions.descriptionTemplate) {
			mrDescription = conventions.descriptionTemplate;
			console.log(chalk.gray('    Description template applied.'));
		}
		if (conventions.baseBranch) {
			baseBranch = conventions.baseBranch;
			console.log(chalk.gray(`    Base branch set to: ${baseBranch}`));
		}
	} else {
		console.log(chalk.gray('  No MR conventions found. Using defaults.'));
	}

	const maxReviewRounds = 5;
	for (let round = 0; round < maxReviewRounds; round++) {
		console.log(chalk.bold.cyan('\n  MR/PR Preview:'));
		console.log(chalk.white(`    Title:  ${mrTitle}`));
		console.log(chalk.white(`    Base:   ${baseBranch}`));
		console.log(chalk.white(`    Description:`));
		for (const line of mrDescription.split('\n')) {
			console.log(chalk.gray(`      ${line}`));
		}
		console.log('');

		const choice = await askUserChoice('Proceed with MR/PR creation?', [
			{ id: 'create', label: 'Create MR/PR' },
			{ id: 'title', label: 'Change title' },
			{ id: 'base', label: 'Change base branch' },
			{ id: 'cancel', label: 'Cancel — skip MR/PR creation' },
		]);

		if (choice.startsWith('__unmatched__:')) {
			mrTitle = choice.slice('__unmatched__:'.length).trim();
			if (!mrTitle.toUpperCase().startsWith(ticketKey.toUpperCase())) {
				mrTitle = `${ticketKey.toUpperCase()} ${mrTitle}`;
			}
			console.log(chalk.green(`  ✓ Title updated to: ${mrTitle}`));
			continue;
		}

		if (choice === 'create') {
			return await createMrOnPlatform(repoPath, ticketKey, branchName, baseBranch, mrTitle, mrDescription);
		}

		if (choice === 'title') {
			const newTitle = await askUser('  Enter new title: ');
			if (newTitle) {
				mrTitle = newTitle.toUpperCase().startsWith(ticketKey.toUpperCase())
					? newTitle
					: `${ticketKey.toUpperCase()} ${newTitle}`;
				console.log(chalk.green(`  ✓ Title updated.`));
			}
			continue;
		}

		if (choice === 'base') {
			const newBase = await askUser(`  Enter base branch (current: ${baseBranch}): `);
			if (newBase) {
				baseBranch = newBase.trim();
				console.log(chalk.green(`  ✓ Base branch updated to: ${baseBranch}`));
			}
			continue;
		}

		if (choice === 'cancel') {
			console.log(chalk.yellow('  MR/PR creation skipped. Branch is already pushed.'));
			return '';
		}
	}

	return await createMrOnPlatform(repoPath, ticketKey, branchName, baseBranch, mrTitle, mrDescription);
}

async function createMrOnPlatform(
	repoPath: string,
	ticketKey: string,
	branchName: string,
	baseBranch: string,
	mrTitle: string,
	mrBody: string,
): Promise<string> {
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
			const prNum = parseInt(prUrl.split('/').pop() ?? '', 10);
			if (prNum) await setCached(prCacheKey(ticketKey), { number: prNum, url: prUrl, platform: 'github' });
			console.log(chalk.green(`  ✓ PR created: ${prUrl}`));
			return prUrl;
		} catch (err: unknown) {
			if (!isEnoent(err)) throw err;
			console.log(chalk.gray('  gh CLI not found, trying GitHub API...'));
		}

		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const prUrl = await createGitHubPR(repoId, branchName, baseBranch, mrTitle, mrBody);
			const prNum = parseInt(prUrl.split('/').pop() ?? '', 10);
			if (prNum) await setCached(prCacheKey(ticketKey), { number: prNum, url: prUrl, platform: 'github' });
			console.log(chalk.green(`  ✓ PR created via API: ${prUrl}`));
			return prUrl;
		} catch (apiErr: unknown) {
			const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
			console.log(chalk.yellow(`  GitHub API failed: ${msg}`));
		}

		const ghManualUrl = await buildManualMrUrl(repoPath, branchName, baseBranch, 'github');
		console.log(chalk.cyan(`  Create PR manually: ${ghManualUrl}`));
		return ghManualUrl;
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
			const mrNum = parseInt(mrUrl.split('/').pop() ?? '', 10);
			if (mrNum) await setCached(prCacheKey(ticketKey), { number: mrNum, url: mrUrl, platform: 'gitlab' });
			console.log(chalk.green(`  ✓ MR created: ${mrUrl}`));
			return mrUrl;
		} catch (err: unknown) {
			if (!isEnoent(err)) throw err;
			console.log(chalk.gray('  glab CLI not found, trying GitLab API...'));
		}

		try {
			const repoId = await parseRepoIdentifier(repoPath);
			const mrUrl = await createGitLabMR(repoId, branchName, baseBranch, mrTitle, mrBody);
			const mrNum = parseInt(mrUrl.split('/').pop() ?? '', 10);
			if (mrNum) await setCached(prCacheKey(ticketKey), { number: mrNum, url: mrUrl, platform: 'gitlab' });
			console.log(chalk.green(`  ✓ MR created via API: ${mrUrl}`));
			return mrUrl;
		} catch (apiErr: unknown) {
			const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
			console.log(chalk.yellow(`  GitLab API failed: ${msg}`));
		}

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
