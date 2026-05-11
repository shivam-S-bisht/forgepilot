#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { activateAxonVenv, getAxonPromptHint, startAxonWatch } from './src/tools/axon/axon.js';
import { parseTodoProgress, launchAgentInBackground, resolveAgentOptionById } from './src/core/agents.js';
import { getJobs, getJob, stopJob } from './src/core/job-manager.js';
import { clearCache, clearCached, getAllCache, getCached, setCached } from './src/core/cache.js';
import { fetchFigmaDesignContext } from './src/tools/figma/figma.js';
import { fetchUnresolvedReviewComments, findOpenPullRequest, gitExec, prepareRepoForWork, pushBranchAndCreateMR, readContributing } from './src/tools/git/git.js';
import { fetchBoards, fetchIssueDetail, fetchTicketsByJql, fetchTicketsByScope, transitionIssueToInProgress } from './src/tools/jira/jira.js';
import type { TicketScope } from './src/tools/jira/jira.js';
import { buildWorkPrompt, getAcceptanceCriteria, getDescriptionText, getJiraBrowseUrl, linkedIssuesText, commentsText } from './src/tools/jira/jira-text.js';
import { extractRepoLabels, getRemoteUrls, scanLocalRepos } from './src/core/repo.js';
import { askQuestionViaSlack, shouldUseSlackQa } from './src/tools/slack/slack.js';

activateAxonVenv();

const server = new McpServer({
	name: 'forgepilot',
	version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Jira Tools
// ---------------------------------------------------------------------------

server.tool(
	'list_tickets',
	'Fetch Jira tickets assigned to the current user. Use scope "current-sprint" for active sprint or "all-assigned" for all unresolved tickets.',
	{
		scope: z.enum(['current-sprint', 'all-assigned']).default('current-sprint').describe('Ticket scope to fetch'),
	},
	async ({ scope }) => {
		const tickets = await fetchTicketsByScope(scope as TicketScope);
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(tickets, null, 2),
			}],
		};
	},
);

server.tool(
	'search_tickets',
	'Search Jira tickets using a custom JQL query. Returns key, title, and status for each match.',
	{
		jql: z.string().describe('JQL query string (e.g. "project = CE AND status = Open")'),
	},
	async ({ jql }) => {
		const tickets = await fetchTicketsByJql(jql);
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(tickets, null, 2),
			}],
		};
	},
);

server.tool(
	'get_ticket_details',
	'Fetch full details for a Jira ticket including description, acceptance criteria, comments, and linked issues.',
	{
		ticket_key: z.string().describe('Jira ticket key (e.g. "CE-1234")'),
	},
	async ({ ticket_key }) => {
		const detail = await fetchIssueDetail(ticket_key);
		const description = getDescriptionText(detail);
		const ac = getAcceptanceCriteria(detail);
		const links = linkedIssuesText(detail);
		const comments = commentsText(detail);
		const url = getJiraBrowseUrl(detail);

		const result = {
			key: detail.key,
			title: detail.fields.summary ?? '(no title)',
			status: detail.fields.status?.name ?? 'Unknown',
			url,
			description,
			acceptanceCriteria: ac,
			linkedIssues: links,
			comments,
		};

		return {
			content: [{
				type: 'text',
				text: JSON.stringify(result, null, 2),
			}],
		};
	},
);

server.tool(
	'transition_ticket',
	'Transition a Jira ticket to a new status. If target_status is not provided, transitions to "In Progress".',
	{
		ticket_key: z.string().describe('Jira ticket key (e.g. "CE-1234")'),
		target_status: z.string().optional().describe('Target status name (default: "In Progress")'),
	},
	async ({ ticket_key, target_status }) => {
		const detail = await fetchIssueDetail(ticket_key);

		if (!target_status || target_status.toLowerCase().includes('progress')) {
			await transitionIssueToInProgress(detail);
			return {
				content: [{ type: 'text', text: `Ticket ${ticket_key} transitioned to In Progress.` }],
			};
		}

		return {
			content: [{ type: 'text', text: `Only "In Progress" transition is currently supported. Use target_status containing "progress".` }],
		};
	},
);

// ---------------------------------------------------------------------------
// Repo Tools
// ---------------------------------------------------------------------------

server.tool(
	'list_local_repos',
	'Scan a directory for local git repositories. Returns paths of all git repos found.',
	{
		root_dir: z.string().describe('Root directory to scan for git repos (e.g. "~/dev")'),
	},
	async ({ root_dir }) => {
		const resolved = root_dir.replace(/^~/, process.env.HOME ?? '~');
		const repos = await scanLocalRepos(resolved);
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(repos, null, 2),
			}],
		};
	},
);

server.tool(
	'resolve_repos',
	'Extract repository URLs from a Jira ticket description and match them to local repos under a root directory.',
	{
		ticket_key: z.string().describe('Jira ticket key to extract repo URLs from'),
		root_dir: z.string().describe('Root directory containing local repos'),
	},
	async ({ ticket_key, root_dir }) => {
		const detail = await fetchIssueDetail(ticket_key);
		const description = getDescriptionText(detail);
		const ticketRepos = extractRepoLabels(description);

		const resolved = root_dir.replace(/^~/, process.env.HOME ?? '~');
		const localRepoPaths = await scanLocalRepos(resolved);

		const remoteIndex = new Map<string, string>();
		for (const localPath of localRepoPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				if (!remoteIndex.has(remote)) remoteIndex.set(remote, localPath);
			}
		}

		const matched: Record<string, string> = {};
		const unmatched: string[] = [];

		for (const repo of ticketRepos) {
			const localPath = remoteIndex.get(repo.normalizedUrl);
			if (localPath) {
				matched[repo.label] = localPath;
			} else {
				unmatched.push(repo.label);
			}
		}

		return {
			content: [{
				type: 'text',
				text: JSON.stringify({
					ticketRepos: ticketRepos.map((r) => ({ label: r.label, url: r.normalizedUrl })),
					matched,
					unmatched,
					localRepoCount: localRepoPaths.length,
				}, null, 2),
			}],
		};
	},
);

// ---------------------------------------------------------------------------
// Git Tools
// ---------------------------------------------------------------------------

server.tool(
	'prepare_branch',
	'Prepare a git repo for work on a ticket: stash changes, fetch latest, checkout base branch, create/checkout ticket branch. Returns the branch name and effective working path.',
	{
		repo_path: z.string().describe('Absolute path to the local git repository'),
		ticket_key: z.string().describe('Jira ticket key (used as branch name, e.g. "CE-1234" → branch "CE-1234")'),
		use_worktree: z.boolean().default(true).describe('If true, creates an isolated git worktree instead of switching branches in-place'),
	},
	async ({ repo_path, ticket_key, use_worktree }) => {
		const effectivePath = await prepareRepoForWork(repo_path, ticket_key, use_worktree);
		const branch = ticket_key.toUpperCase();
		return {
			content: [{
				type: 'text',
				text: JSON.stringify({ branch, effectivePath, worktree: use_worktree }, null, 2),
			}],
		};
	},
);

server.tool(
	'get_branch_status',
	'Get the current git status of a repository: branch name, uncommitted changes, and recent commit log.',
	{
		repo_path: z.string().describe('Absolute path to the git repository'),
	},
	async ({ repo_path }) => {
		const branch = await gitExec(repo_path, ['branch', '--show-current']);
		const status = await gitExec(repo_path, ['status', '--porcelain']);
		let log = '';
		try {
			log = await gitExec(repo_path, ['log', '--oneline', '-10']);
		} catch {
			// No commits yet.
		}

		return {
			content: [{
				type: 'text',
				text: JSON.stringify({
					branch,
					uncommittedChanges: status ? status.split('\n') : [],
					recentCommits: log ? log.split('\n') : [],
				}, null, 2),
			}],
		};
	},
);

server.tool(
	'commit_changes',
	'Stage all changes and create a git commit in the specified repository.',
	{
		repo_path: z.string().describe('Absolute path to the git repository'),
		message: z.string().describe('Commit message'),
		stage_all: z.boolean().default(true).describe('If true, stages all changes (git add -A) before committing'),
	},
	async ({ repo_path, message, stage_all }) => {
		if (stage_all) {
			await gitExec(repo_path, ['add', '-A']);
			const metaGlobs = ['.forgepilot-todos-*.md', '.forgepilot-questions-*.md', '.forgepilot-answers-*.md'];
			for (const glob of metaGlobs) {
				try {
					await gitExec(repo_path, ['reset', 'HEAD', '--', glob]);
				} catch {
					// File may not exist or not be staged
				}
			}
		}

		const TRAILER_RE = /^[\w-]+-by:\s/i;
		const lines = message.split('\n');
		while (lines.length > 0) {
			const last = lines[lines.length - 1].trim();
			if (last === '' || TRAILER_RE.test(last)) {
				lines.pop();
			} else {
				break;
			}
		}
		const cleanMessage = lines.join('\n').trimEnd() || message;

		await gitExec(repo_path, ['commit', '-m', cleanMessage]);
		const hash = await gitExec(repo_path, ['rev-parse', '--short', 'HEAD']);
		return {
			content: [{ type: 'text', text: `Committed: ${hash} — ${cleanMessage}` }],
		};
	},
);

server.tool(
	'push_and_create_pr',
	'Push the current branch to remote and create a Pull Request (GitHub) or Merge Request (GitLab). Auto-detects the platform.',
	{
		repo_path: z.string().describe('Absolute path to the git repository'),
		ticket_key: z.string().describe('Jira ticket key (used in PR/MR title)'),
		title: z.string().describe('PR/MR title (ticket key will be prepended)'),
	},
	async ({ repo_path, ticket_key, title }) => {
		let jiraUrl = '';
		try {
			const detail = await fetchIssueDetail(ticket_key);
			jiraUrl = getJiraBrowseUrl(detail);
		} catch {
			// Non-critical, continue without Jira URL.
		}

		const url = await pushBranchAndCreateMR(repo_path, ticket_key, title, jiraUrl);
		return {
			content: [{
				type: 'text',
				text: url ? `PR/MR created: ${url}` : 'Branch pushed but no PR/MR URL returned (platform not detected as GitHub or GitLab).',
			}],
		};
	},
);

// ---------------------------------------------------------------------------
// Context Tools
// ---------------------------------------------------------------------------

server.tool(
	'get_figma_context',
	'Fetch Figma design data for a ticket. Extracts Figma links from the ticket, fetches node structure, rendered images, and design tokens. Requires FORGEPILOT_FIGMA_PAT to be set.',
	{
		ticket_key: z.string().describe('Jira ticket key to extract Figma links from'),
	},
	async ({ ticket_key }) => {
		const detail = await fetchIssueDetail(ticket_key);
		const context = await fetchFigmaDesignContext(detail);
		return {
			content: [{
				type: 'text',
				text: context || 'No Figma design context found for this ticket.',
			}],
		};
	},
);

server.tool(
	'get_axon_context',
	'Get the Axon knowledge graph structural reasoning hint for a repository. Returns the Axon protocol prompt section if an .axon/ graph exists in the repo.',
	{
		repo_path: z.string().describe('Absolute path to the git repository'),
	},
	async ({ repo_path }) => {
		const hint = getAxonPromptHint(repo_path);
		return {
			content: [{
				type: 'text',
				text: hint || 'No Axon knowledge graph found at .axon/ in this repository.',
			}],
		};
	},
);

server.tool(
	'get_contributing_guidelines',
	'Read repository coding guidelines from AGENTS.md (preferred) or CONTRIBUTING.md. Returns the content (up to 12KB) for use as coding guidelines.',
	{
		repo_path: z.string().describe('Absolute path to the git repository'),
	},
	async ({ repo_path }) => {
		const content = await readContributing(repo_path);
		return {
			content: [{
				type: 'text',
				text: content || 'No AGENTS.md or CONTRIBUTING.md found in this repository.',
			}],
		};
	},
);

server.tool(
	'build_prompt',
	'Build the full structured AI prompt for a Jira ticket. Combines ticket context, contributing guidelines, Figma designs, Axon hints, and any cached clarifications into a single prompt.',
	{
		ticket_key: z.string().describe('Jira ticket key'),
		repo_path: z.string().describe('Absolute path to the primary repository (for contributing guidelines and Axon)'),
	},
	async ({ ticket_key, repo_path }) => {
		const detail = await fetchIssueDetail(ticket_key);
		const contributing = await readContributing(repo_path);
		const axonHint = getAxonPromptHint(repo_path);
		const figmaSection = await fetchFigmaDesignContext(detail);

		const prompt = buildWorkPrompt(detail, contributing, '', axonHint, figmaSection);
		return {
			content: [{ type: 'text', text: prompt }],
		};
	},
);

// ---------------------------------------------------------------------------
// Memory / Cache Tools
// ---------------------------------------------------------------------------

server.tool(
	'cache_get',
	'Read a value from the ForgePilot cache by key. Returns null if the key does not exist.',
	{
		key: z.string().describe('Cache key (e.g. "rootDir", "repoChoice_CE-1234", "branch-state-CE-1234")'),
	},
	async ({ key }) => {
		const value = await getCached(key);
		return {
			content: [{
				type: 'text',
				text: value !== null ? JSON.stringify(value, null, 2) : 'null (key not found in cache)',
			}],
		};
	},
);

server.tool(
	'cache_set',
	'Write a value to the ForgePilot cache. Values are persisted as JSON files in the .cache/ directory.',
	{
		key: z.string().describe('Cache key'),
		value: z.string().describe('Value to store (will be parsed as JSON if valid, otherwise stored as string)'),
	},
	async ({ key, value }) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			parsed = value;
		}
		await setCached(key, parsed);
		return {
			content: [{ type: 'text', text: `Cached "${key}" successfully.` }],
		};
	},
);

server.tool(
	'cache_list',
	'List all keys and values currently stored in the ForgePilot cache.',
	{},
	async () => {
		const all = await getAllCache();
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(all, null, 2),
			}],
		};
	},
);

server.tool(
	'cache_clear',
	'Clear the entire ForgePilot cache. This removes all cached values.',
	{},
	async () => {
		await clearCache();
		return {
			content: [{ type: 'text', text: 'Cache cleared.' }],
		};
	},
);

// ---------------------------------------------------------------------------
// Workflow Tools
// ---------------------------------------------------------------------------

server.tool(
	'work_on_ticket',
	'High-level workflow: resolves repos from a ticket, prepares git branches, fetches all context (Figma, Axon, contributing), transitions the ticket to In Progress, and returns the full AI prompt plus repo paths. This is the all-in-one tool to start working on a ticket.',
	{
		ticket_key: z.string().describe('Jira ticket key (e.g. "CE-1234")'),
		root_dir: z.string().describe('Root directory containing local repos (e.g. "~/dev")'),
		use_worktree: z.boolean().default(true).describe('If true, creates isolated git worktrees for each repo'),
	},
	async ({ ticket_key, root_dir, use_worktree }) => {
		const detail = await fetchIssueDetail(ticket_key);

		const description = getDescriptionText(detail);
		const ticketRepos = extractRepoLabels(description);
		const resolvedRoot = root_dir.replace(/^~/, process.env.HOME ?? '~');
		const localRepoPaths = await scanLocalRepos(resolvedRoot);

		const remoteIndex = new Map<string, string>();
		for (const localPath of localRepoPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				if (!remoteIndex.has(remote)) remoteIndex.set(remote, localPath);
			}
		}

		const repoMap = new Map<string, string>();
		for (const repo of ticketRepos) {
			const localPath = remoteIndex.get(repo.normalizedUrl);
			if (localPath) repoMap.set(repo.label, localPath);
		}

		if (!repoMap.size && localRepoPaths.length) {
			const cached = await getCached<string[]>(`repoChoice_${ticket_key}`);
			if (cached?.length) {
				for (const p of cached) {
					const name = p.split('/').pop() ?? p;
					repoMap.set(name, p);
				}
			}
		}

		if (!repoMap.size) {
			return {
				content: [{
					type: 'text',
					text: JSON.stringify({
						error: 'No repos resolved. Use resolve_repos or list_local_repos to find repos, then use prepare_branch directly.',
						availableRepos: localRepoPaths,
					}, null, 2),
				}],
			};
		}

		const preparedRepos: Record<string, string> = {};
		for (const [name, repoPath] of repoMap) {
			const effectivePath = await prepareRepoForWork(repoPath, ticket_key, use_worktree);
			preparedRepos[name] = effectivePath;
		}

		const primaryRepoPath = Object.values(preparedRepos)[0];
		const contributing = await readContributing(primaryRepoPath);
		const axonHint = getAxonPromptHint(primaryRepoPath);
		const figmaSection = await fetchFigmaDesignContext(detail);

		const prompt = buildWorkPrompt(detail, contributing, '', axonHint, figmaSection);

		try {
			await transitionIssueToInProgress(detail);
		} catch {
			// Non-critical failure.
		}

		const axonChild = startAxonWatch(primaryRepoPath);
		const axonPid = axonChild?.pid ?? null;

		return {
			content: [{
				type: 'text',
				text: JSON.stringify({
					ticketKey: detail.key,
					title: detail.fields.summary,
					status: 'In Progress',
					branch: ticket_key.toUpperCase(),
					repos: preparedRepos,
					jiraUrl: getJiraBrowseUrl(detail),
					axonWatchPid: axonPid,
					prompt,
				}, null, 2),
			}],
		};
	},
);

server.tool(
	'get_boards',
	'Fetch all Jira boards visible to the current user. Returns board IDs and names.',
	{},
	async () => {
		const boards = await fetchBoards();
		const result = [...boards.entries()].map(([id, name]) => ({ id, name }));
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(result, null, 2),
			}],
		};
	},
);

// ---------------------------------------------------------------------------
// Q&A
// ---------------------------------------------------------------------------

server.tool(
	'ask_question',
	'Ask the user a question and wait for their answer. Routes to Slack if FORGEPILOT_SLACK_QA is enabled, otherwise returns an error asking the caller to include the question in its output. Use this when you encounter ambiguity or need clarification during work.',
	{
		question: z.string().describe('The question to ask the user'),
		ticket_key: z.string().optional().describe('Jira ticket key for context (e.g. CE-1234)'),
	},
	async ({ question, ticket_key }) => {
		const ticketKey = ticket_key ?? 'UNKNOWN';

		if (shouldUseSlackQa()) {
			const answer = await askQuestionViaSlack(question, ticketKey, 1, 1);
			return {
				content: [{
					type: 'text',
					text: answer ? `User answered: ${answer}` : 'User skipped this question. Use your best judgment.',
				}],
			};
		}

		return {
			content: [{
				type: 'text',
				text: `Slack Q&A is not enabled. Please include this question in your response so the user can answer it directly: "${question}"`,
			}],
		};
	},
);

// ---------------------------------------------------------------------------
// Checkpoint & Todo Tools
// ---------------------------------------------------------------------------

server.tool(
	'get_todo_progress',
	'Read and parse the .forgepilot-todos-<KEY>.md file from a repo. Returns completed/pending item counts and descriptions. Use this to check how far an agent got on a ticket.',
	{
		repo_path: z.string().describe('Absolute path to the git repository (or worktree)'),
		ticket_key: z.string().describe('Jira ticket key (e.g. "CE-1234")'),
	},
	async ({ repo_path, ticket_key }) => {
		const progress = await parseTodoProgress(repo_path, ticket_key);
		if (!progress) {
			return {
				content: [{ type: 'text', text: `No todo file found for ${ticket_key} in ${repo_path}.` }],
			};
		}
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(progress, null, 2),
			}],
		};
	},
);

server.tool(
	'get_checkpoint',
	'Load checkpoint metadata for a ticket. Returns the agent used, timestamps, and repo path from the last interrupted run. Returns null if no checkpoint exists.',
	{
		ticket_key: z.string().describe('Jira ticket key (e.g. "CE-1234")'),
	},
	async ({ ticket_key }) => {
		const checkpoint = await getCached(`checkpoint-${ticket_key.toUpperCase()}`);
		if (!checkpoint) {
			return {
				content: [{ type: 'text', text: `No checkpoint found for ${ticket_key}.` }],
			};
		}
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(checkpoint, null, 2),
			}],
		};
	},
);

server.tool(
	'clear_checkpoint',
	'Discard checkpoint metadata and optionally the todo file for a ticket. Use this to reset state before starting fresh.',
	{
		ticket_key: z.string().describe('Jira ticket key (e.g. "CE-1234")'),
		repo_path: z.string().optional().describe('If provided, also deletes the .forgepilot-todos-<KEY>.md file from this path'),
	},
	async ({ ticket_key, repo_path }) => {
		await clearCached(`checkpoint-${ticket_key.toUpperCase()}`);
		const messages = [`Checkpoint cleared for ${ticket_key}.`];

		if (repo_path) {
			const { existsSync } = await import('node:fs');
			const { unlink } = await import('node:fs/promises');
			const { join } = await import('node:path');
			const todoFile = join(repo_path, `.forgepilot-todos-${ticket_key.toUpperCase()}.md`);
			if (existsSync(todoFile)) {
				await unlink(todoFile);
				messages.push(`Todo file deleted: ${todoFile}`);
			}
		}

		return {
			content: [{ type: 'text', text: messages.join('\n') }],
		};
	},
);

server.tool(
	'get_review_comments',
	'Find an open PR/MR for a ticket branch and fetch unresolved review comments. Requires FORGEPILOT_GITHUB_TOKEN or FORGEPILOT_GITLAB_TOKEN. Returns the PR/MR info and comment details.',
	{
		repo_path: z.string().describe('Absolute path to the git repository'),
		ticket_key: z.string().describe('Jira ticket key (branch name, e.g. "CE-1234")'),
	},
	async ({ repo_path, ticket_key }) => {
		const pr = await findOpenPullRequest(repo_path, ticket_key);
		if (!pr) {
			return {
				content: [{ type: 'text', text: `No open PR/MR found for branch ${ticket_key.toUpperCase()}.` }],
			};
		}

		const comments = await fetchUnresolvedReviewComments(repo_path, pr);
		return {
			content: [{
				type: 'text',
				text: JSON.stringify({
					pullRequest: {
						number: pr.number,
						url: pr.url,
						title: pr.title,
						platform: pr.platform,
					},
					unresolvedComments: comments.map((c) => ({
						id: c.id,
						path: c.path,
						line: c.line,
						body: c.body,
						author: c.author,
						url: c.url,
					})),
					totalUnresolved: comments.length,
				}, null, 2),
			}],
		};
	},
);

// ---------------------------------------------------------------------------
// Background Job Tools
// ---------------------------------------------------------------------------

server.tool(
	'list_jobs',
	'List all background agent jobs with their status, ticket key, agent, and timing.',
	{},
	async () => {
		const jobs = await getJobs();
		return {
			content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }],
		};
	},
);

server.tool(
	'get_job_status',
	'Get the status of a background agent job for a specific ticket.',
	{
		ticket_key: z.string().describe('Jira ticket key, e.g. CE-1234'),
	},
	async ({ ticket_key }) => {
		const job = await getJob(ticket_key);
		if (!job) {
			return { content: [{ type: 'text', text: `No background job found for ${ticket_key}` }] };
		}
		return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
	},
);

server.tool(
	'launch_background_agent',
	'Launch an AI agent in the background for a Jira ticket. Returns the job record with PID and log file path. The job is only marked done after automated completion verification passes.',
	{
		ticket_key: z.string().describe('Jira ticket key, e.g. CE-1234'),
		agent_id: z.string().describe('Agent option ID, e.g. claude-code-autonomous, copilot-autonomous'),
		root_dir: z.string().describe('Root directory containing local repos (e.g. "~/dev")'),
	},
	async ({ ticket_key, agent_id, root_dir }) => {
		const agentOption = resolveAgentOptionById(agent_id);
		if (!agentOption) {
			return { content: [{ type: 'text', text: `Unknown agent ID: ${agent_id}` }] };
		}

		const detail = await fetchIssueDetail(ticket_key);
		const description = getDescriptionText(detail);
		const ticketRepos = extractRepoLabels(description);
		const resolvedRoot = root_dir.replace(/^~/, process.env.HOME ?? '~');
		const localRepoPaths = await scanLocalRepos(resolvedRoot);

		const remoteIndex = new Map<string, string>();
		for (const localPath of localRepoPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				if (!remoteIndex.has(remote)) remoteIndex.set(remote, localPath);
			}
		}

		const repoMap = new Map<string, string>();
		for (const repo of ticketRepos) {
			const localPath = remoteIndex.get(repo.normalizedUrl);
			if (localPath) repoMap.set(repo.label, localPath);
		}

		if (!repoMap.size && localRepoPaths.length) {
			const cached = await getCached<string[]>(`repoChoice_${ticket_key}`);
			if (cached?.length) {
				for (const p of cached) {
					const name = p.split('/').pop() ?? p;
					repoMap.set(name, p);
				}
			}
		}

		if (!repoMap.size) {
			return { content: [{ type: 'text', text: `No repos found for ${ticket_key}. Check ticket description or cache.` }] };
		}

		const job = await launchAgentInBackground(detail, agentOption, repoMap);
		return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
	},
);

server.tool(
	'stop_job',
	'Stop a running background agent job for a ticket.',
	{
		ticket_key: z.string().describe('Jira ticket key, e.g. CE-1234'),
	},
	async ({ ticket_key }) => {
		const stopped = await stopJob(ticket_key);
		return {
			content: [{ type: 'text', text: stopped ? `Stopped job for ${ticket_key}` : `Could not stop job for ${ticket_key} (not running or not found)` }],
		};
	},
);

server.tool(
	'get_job_logs',
	'Get the last N lines of a background agent log file for a ticket.',
	{
		ticket_key: z.string().describe('Jira ticket key, e.g. CE-1234'),
		tail_lines: z.number().default(50).describe('Number of lines to return from end of log'),
	},
	async ({ ticket_key, tail_lines }) => {
		const job = await getJob(ticket_key);
		if (!job) {
			return { content: [{ type: 'text', text: `No background job found for ${ticket_key}` }] };
		}
		if (!existsSync(job.logFile)) {
			return { content: [{ type: 'text', text: 'Log file not found yet.' }] };
		}
		const content = readFileSync(job.logFile, 'utf8');
		const lines = content.split('\n').slice(-tail_lines).join('\n');
		return { content: [{ type: 'text', text: lines || '(no output yet)' }] };
	},
);

// ---------------------------------------------------------------------------
// Voice Tools
// ---------------------------------------------------------------------------

server.tool(
	'start_voice_mode',
	'Start ForgePilot push-to-talk voice mode with AI-powered natural language understanding. Uses sherpa-onnx-node (Whisper) for in-process speech recognition, sox for recording, and copilot/cursor CLI for AI command parsing. Supports all CLI operations: fetch/search tickets by status or keyword, start work on single or multiple tickets in parallel, commit changes, prepare branches, push and create PRs, and more. Press Space to start/stop recording. Only works in a terminal with microphone access.',
	{},
	async () => {
		const { startVoiceMode } = await import('./src/tools/voice/voice.js');
		startVoiceMode().catch(() => { });
		return {
			content: [{
				type: 'text',
				text: 'Voice mode started. Press Space to start recording, press Space again to stop. Press q to exit. Speak naturally — AI parses your commands.',
			}],
		};
	},
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	process.stderr.write(`ForgePilot MCP server error: ${error}\n`);
	process.exit(1);
});
