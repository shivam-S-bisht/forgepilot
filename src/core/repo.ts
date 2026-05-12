import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getCached, setCached } from './cache.js';
import {
	getDescriptionText,
	getAcceptanceCriteria,
	collectRepoUrlsFromIssue,
} from '../tools/jira/jira-text.js';
import { postAndWaitForSelection } from '../tools/slack/slack.js';
import type { SlackPickOption } from '../tools/slack/slack.js';
import type { JiraIssueDetail, RepoLabel, TicketRepoResolution } from './types.js';
import { renderRepoPicker } from './ui.js';
import { askUser, askUserChoice } from './ask.js';
import { isVoiceModeActive } from '../tools/voice/voice-input.js';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO_SCAN_DEPTH = 3;

function getRepoScanDepth(): number {
	const raw = process.env.FORGEPILOT_REPO_SCAN_DEPTH?.trim();
	if (!raw) return DEFAULT_REPO_SCAN_DEPTH;
	const parsed = parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_REPO_SCAN_DEPTH;
	return Math.max(1, Math.min(parsed, 10));
}

export function normalizeRepoUrl(raw: string): string {
	if (!raw) return '';
	let value = raw.trim().replace(/[),.;]+$/, '');
	const ssh = value.match(/^git@([^:]+):(.+)$/);
	if (ssh) value = `${ssh[1]}/${ssh[2]}`;
	else {
		try {
			const u = new URL(value);
			value = `${u.hostname}${u.pathname}`;
		} catch {
			// Not a valid URL; keep as-is.
		}
	}
	return value.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

export function extractRepoLabels(text: string): RepoLabel[] {
	const urlRegex = /(https?:\/\/[^\s\])]+|git@[^\s\])]+)/gi;
	const results: RepoLabel[] = [];
	let match: RegExpExecArray | null;
	while ((match = urlRegex.exec(text)) !== null) {
		const rawUrl = match[1];
		const normalized = normalizeRepoUrl(rawUrl);
		if (!normalized) continue;
		const slug = normalized.split('/').pop() ?? normalized;
		if (!results.some((r) => r.normalizedUrl === normalized)) {
			results.push({ label: slug, normalizedUrl: normalized });
		}
	}
	return results;
}

/** Repo URLs from description/AC text plus any GitHub/GitLab/etc. URLs anywhere in Jira `fields` (smart links, dev panel, custom fields). */
export function extractTicketRepoLabels(detail: JiraIssueDetail): RepoLabel[] {
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const fullText = [description, ac].filter((t) => t && t !== 'Not available').join('\n');
	const fromText = extractRepoLabels(fullText);
	const fromFields = collectRepoUrlsFromIssue(detail);
	const byNorm = new Map<string, RepoLabel>();
	for (const r of fromText) byNorm.set(r.normalizedUrl, r);
	for (const raw of fromFields) {
		const normalized = normalizeRepoUrl(raw);
		if (!normalized || byNorm.has(normalized)) continue;
		const slug = normalized.split('/').pop() ?? normalized;
		byNorm.set(normalized, { label: slug, normalizedUrl: normalized });
	}
	return [...byNorm.values()];
}

export async function scanLocalRepos(rootDir: string, depth = 0, maxDepth = DEFAULT_REPO_SCAN_DEPTH): Promise<string[]> {
	if (depth > maxDepth) return [];
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	const repos: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
		const full = path.join(rootDir, entry.name);
		if (existsSync(path.join(full, '.git'))) repos.push(full);
		else repos.push(...(await scanLocalRepos(full, depth + 1, maxDepth)));
	}
	return repos;
}

export async function getRemoteUrls(repoPath: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', '-v']);
		return [
			...new Set(
				stdout
					.split('\n')
					.map((l) => normalizeRepoUrl(l.trim().split(/\s+/)[1] ?? ''))
					.filter(Boolean),
			),
		];
	} catch {
		return [];
	}
}

function findMatchingRepo(normalizedUrl: string, remoteIndex: Map<string, string[]>): string | undefined {
	const exact = remoteIndex.get(normalizedUrl) ?? [];
	if (exact.length === 1) return exact[0];

	const partialMatches = new Set<string>();
	for (const [remote, localPaths] of remoteIndex) {
		if (remote.includes(normalizedUrl) || normalizedUrl.includes(remote)) {
			for (const localPath of localPaths) partialMatches.add(localPath);
		}
	}

	// Do not auto-pick when matching is ambiguous (e.g. multiple repos named "admin").
	if (partialMatches.size === 1) {
		return [...partialMatches][0];
	}

	return undefined;
}

export const AI_DECIDES_SENTINEL = '__ai_decides__';

/** Format repository paths for display, handling naming collisions by showing parent directory context. */
export function formatRepoPathForDisplay(repos: string[]): Map<string, string> {
	const displayNames = new Map<string, string>();
	const basenameCount = new Map<string, string[]>();

	// Count repos by basename to detect collisions
	for (const repo of repos) {
		const basename = path.basename(repo);
		if (!basenameCount.has(basename)) {
			basenameCount.set(basename, []);
		}
		basenameCount.get(basename)!.push(repo);
	}

	// Format display names with local path context so similarly named repos are obvious.
	for (const repo of repos) {
		const basename = path.basename(repo);
		const siblings = basenameCount.get(basename) ?? [];
		const relPath = repo;

		if (siblings.length === 1) {
			displayNames.set(repo, `${basename} - ${relPath}`);
		} else {
			const parent = path.basename(path.dirname(repo));
			displayNames.set(repo, `${parent}/${basename} - ${relPath}`);
		}
	}

	return displayNames;
}

export function pickReposInteractive(
	repos: string[],
	title: string,
	options?: { includeAiOption?: boolean },
): Promise<string[]> {
	const displayNames = formatRepoPathForDisplay(repos);
	const displayItems = options?.includeAiOption
		? [...repos, AI_DECIDES_SENTINEL]
		: [...repos];

	return new Promise((resolve) => {
		let cursorIndex = 0;
		const selectedIndices = new Set<number>();

		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);

		const formatForRender = (item: string): string => {
			if (item === AI_DECIDES_SENTINEL) return '✨ Let AI figure it out (select all repos)';
			if (item === MANUAL_URL_SENTINEL) return '🔗 Enter a repo URL or local path';
			return displayNames.get(item) ?? item;
		};

		const render = () => renderRepoPicker(
			displayItems.map(formatForRender),
			cursorIndex,
			selectedIndices,
			title,
		);

		render();

		const onKeypress = (_: unknown, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				process.exit(0);
			}

			if (key.name === 'up') {
				cursorIndex = cursorIndex === 0 ? displayItems.length - 1 : cursorIndex - 1;
				render();
				return;
			}

			if (key.name === 'down') {
				cursorIndex = cursorIndex === displayItems.length - 1 ? 0 : cursorIndex + 1;
				render();
				return;
			}

			if (key.name === 'space') {
				if (displayItems[cursorIndex] === AI_DECIDES_SENTINEL) {
					const allSelected = repos.every((_, i) => selectedIndices.has(i));
					if (allSelected) {
						selectedIndices.clear();
					} else {
						for (let i = 0; i < repos.length; i++) selectedIndices.add(i);
					}
				} else {
					if (selectedIndices.has(cursorIndex)) selectedIndices.delete(cursorIndex);
					else selectedIndices.add(cursorIndex);
				}
				render();
				return;
			}

			if (key.name === 'return' || key.name === 'enter') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				let indices = [...selectedIndices].sort((a, b) => a - b);
				if (indices.length === 0 && displayItems.length > 0) {
					indices = [cursorIndex];
				}
				const picked = indices.map((i) => displayItems[i]);
				if (process.stdin.readable) process.stdin.resume();
				resolve(picked);
			}
		};

		process.stdin.on('keypress', onKeypress);
	});
}

async function pickReposVoice(repos: string[], ticketKey: string): Promise<string[]> {
	const selected: string[] = [];

	while (true) {
		const remaining = repos.filter((r) => !selected.includes(r));
		if (!remaining.length) break;

		const options = remaining.map((r, i) => ({
			id: String(i),
			label: path.basename(r),
		}));
		options.push({ id: 'done', label: selected.length ? 'Done selecting' : 'Skip — no repos' });

		const prompt = selected.length
			? `Selected ${selected.length} repo(s). Add another for ${ticketKey}?`
			: `Select a repo for ${ticketKey}:`;

		const choice = await askUserChoice(prompt, options);

		if (choice === 'done') break;
		if (choice.startsWith('__unmatched__:')) break;

		const idx = parseInt(choice, 10);
		if (!isNaN(idx) && idx >= 0 && idx < remaining.length) {
			selected.push(remaining[idx]);
			console.log(chalk.green(`  ✓ Added: ${path.basename(remaining[idx])}`));
		}
	}

	return selected;
}

async function pickReposVoiceWithUrl(repos: string[], ticketKey: string): Promise<string[]> {
	const selected = await pickReposVoice(repos, ticketKey);
	if (selected.length) return selected;

	const wantUrl = await askUserChoice('No repos selected. Would you like to enter a repo URL instead?', [
		{ id: 'yes', label: 'Yes — enter a URL or path' },
		{ id: 'no', label: 'No — cancel' },
	]);
	if (wantUrl === 'yes') return [MANUAL_URL_SENTINEL];
	return [];
}

export const MANUAL_URL_SENTINEL = '__enter_url__';

async function resolveManualUrl(
	url: string,
	localRepoPaths: string[],
	remoteIndex?: Map<string, string[]>,
): Promise<string | null> {
	const normalized = normalizeRepoUrl(url);
	if (!normalized) return null;

	const idx = remoteIndex ?? new Map<string, string[]>();
	if (!remoteIndex) {
		for (const localPath of localRepoPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				const localPaths = idx.get(remote) ?? [];
				localPaths.push(localPath);
				idx.set(remote, localPaths);
			}
		}
	}

	const match = findMatchingRepo(normalized, idx);
	if (match) return match;

	const asPath = path.resolve(url.replace(/^~/, process.env.HOME ?? '~'));
	if (existsSync(path.join(asPath, '.git'))) return asPath;

	return null;
}

function extractJsonPayload(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const braces = text.match(/\{[\s\S]*\}/);
	if (braces) return braces[0];
	return text.trim();
}

async function detectRepoWithAi(
	detail: JiraIssueDetail,
	localRepoPaths: string[],
): Promise<string[]> {
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const fullText = [description, ac].filter((t) => t && t !== 'Not available').join('\n');
	const repoList = localRepoPaths.map((p) => path.basename(p)).join(', ');

	const prompt = [
		'Analyze this Jira ticket and determine which local repository the work should be done in.',
		'Return ONLY valid JSON: {"repos":["repo-name"]} with the most likely repo name(s) from the list below.',
		'If you cannot determine the repo, return {"repos":[]}.',
		'',
		`Ticket: ${detail.key} — ${detail.fields.summary ?? ''}`,
		`Description: ${fullText.slice(0, 3000)}`,
		'',
		`Available local repos: ${repoList}`,
	].join('\n');

	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();

	try {
		let stdout = '';
		if (preflightAgent === 'copilot') {
			({ stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 15_000 }));
		} else if (preflightAgent === 'cursor') {
			({ stdout } = await execFileAsync('cursor', ['agent', '--mode', 'plan', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 15_000 }));
		} else {
			return [];
		}

		const json = extractJsonPayload(stdout);
		const parsed = JSON.parse(json) as { repos?: string[] };
		if (!parsed.repos?.length) return [];

		const matched: string[] = [];
		for (const name of parsed.repos) {
			const lower = name.toLowerCase();
			const found = localRepoPaths.find((p) => path.basename(p).toLowerCase() === lower);
			if (found) matched.push(found);
		}
		return matched;
	} catch {
		return [];
	}
}

export async function resolveRepoPathsFromUser(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const repoMap = new Map<string, string>();
	const cacheKey = `repoChoice_${detail.key}`;

	// --- Step 1: Check cache first ---
	const cached = await getCached<string[]>(cacheKey);
	if (cached?.length) {
		const allValid = cached.every((p) => existsSync(path.join(p, '.git')));
		if (allValid) {
			console.log(chalk.gray(`Using cached repo selection for ${detail.key}:`));
			for (const p of cached) {
				repoMap.set(p, p);
				console.log(chalk.green(`  ✓ ${path.basename(p)} → ${p}`));
			}
			return repoMap;
		}
		console.log(chalk.gray(`  Cached repo paths for ${detail.key} are no longer valid. Re-resolving...`));
	}

	// --- Step 2: Ensure root directory ---
	let rootDir = await getCached<string>('rootDir');
	if (!rootDir) {
		const input = await askUser('Root directory containing your repos (e.g. ~/dev): ');
		if (!input) throw new Error('Root directory is required.');
		rootDir = path.resolve(input.replace(/^~/, process.env.HOME ?? '~'));
		if (!existsSync(rootDir)) throw new Error(`Directory does not exist: ${rootDir}`);
		await setCached('rootDir', rootDir);
	} else {
		console.log(chalk.gray(`Using cached root directory: ${rootDir}`));
	}

	const scanDepth = getRepoScanDepth();
	console.log(chalk.gray(`\nScanning repos under ${rootDir} (depth ${scanDepth}) ...`));
	const localRepoPaths = await scanLocalRepos(rootDir, 0, scanDepth);
	console.log(chalk.gray(`  Found ${localRepoPaths.length} local git repo(s).`));

	// --- Step 3: Try matching repo URLs (description, AC, Jira smart links / dev fields) ---
	const ticketRepos = extractTicketRepoLabels(detail);

	if (ticketRepos.length) {
		console.log(chalk.bold(`\nFound ${ticketRepos.length} repo URL(s) in ticket description:`));
		for (const repo of ticketRepos) {
			console.log(chalk.cyan(`  ${repo.label} (${repo.normalizedUrl})`));
		}

		const remoteIndex = new Map<string, string[]>();
		for (const localPath of localRepoPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				const localPaths = remoteIndex.get(remote) ?? [];
				localPaths.push(localPath);
				remoteIndex.set(remote, localPaths);
			}
		}

		const missing: string[] = [];
		for (const repo of ticketRepos) {
			const localPath = findMatchingRepo(repo.normalizedUrl, remoteIndex);
			if (localPath) {
				repoMap.set(repo.normalizedUrl, localPath);
				console.log(chalk.green(`  ✓ ${repo.label} → ${localPath}`));
			} else {
				missing.push(repo.label);
				console.log(chalk.yellow(`  ✗ ${repo.label} (${repo.normalizedUrl}) — not found locally`));
			}
		}

		if (!missing.length) {
			await setCached(cacheKey, [...repoMap.values()]);
			return repoMap;
		}

		if (repoMap.size > 0) {
			console.log(chalk.yellow(`\n  ${missing.length} repo(s) not found locally. Continuing with matched repos.`));
		} else {
			console.log(chalk.yellow('\n  None of the ticket repos were found locally.'));
		}
	}

	// --- Step 4: AI-based repo detection ---
	if (!repoMap.size && localRepoPaths.length) {
		console.log(chalk.gray('\n  No repo URL found in ticket. Asking AI to identify the repo...'));
		const aiMatched = await detectRepoWithAi(detail, localRepoPaths);
		if (aiMatched.length) {
			console.log(chalk.green(`  AI suggests: ${aiMatched.map((p) => path.basename(p)).join(', ')}`));
			const confirmChoice = await askUserChoice('Use AI-suggested repo(s)?', [
				{ id: 'yes', label: `Yes — use ${aiMatched.map((p) => path.basename(p)).join(', ')}` },
				{ id: 'pick', label: 'No — let me pick manually' },
			]);
			if (confirmChoice === 'yes') {
				for (const p of aiMatched) repoMap.set(p, p);
				await setCached(cacheKey, aiMatched);
				return repoMap;
			}
		} else {
			console.log(chalk.gray('  AI could not determine the repo either.'));
		}
	}

	// --- Step 5: Ask user to pick or provide a URL ---
	if (!repoMap.size) {
		console.log(chalk.yellow('\n  ⚠ No repository URL found in the ticket description or acceptance criteria.'));
		console.log(chalk.gray('  Please select a repo from the list below, or enter a URL.\n'));

		if (!localRepoPaths.length) {
			const manualPath = await askUser('No local repos found. Enter a repo path or URL: ');
			if (!manualPath) throw new Error('No repo path provided.');
			const resolved = await resolveManualUrl(manualPath, localRepoPaths);
			if (resolved) {
				repoMap.set(resolved, resolved);
				await setCached(cacheKey, [resolved]);
				console.log(chalk.green(`  ✓ ${path.basename(resolved)} → ${resolved}`));
				return repoMap;
			}
			const asPath = path.resolve(manualPath.replace(/^~/, process.env.HOME ?? '~'));
			if (!existsSync(path.join(asPath, '.git'))) throw new Error(`Not a git repository: ${asPath}`);
			repoMap.set(asPath, asPath);
			await setCached(cacheKey, [asPath]);
			return repoMap;
		}

		const reposWithUrlOption = [...localRepoPaths, MANUAL_URL_SENTINEL];
		const picked = isVoiceModeActive()
			? await pickReposVoiceWithUrl(localRepoPaths, detail.key)
			: await pickReposInteractive(reposWithUrlOption, `Select repo(s) for ${detail.key}`);

		const manualUrlPicks = picked.filter((p) => p === MANUAL_URL_SENTINEL);
		const repoPicks = picked.filter((p) => p !== MANUAL_URL_SENTINEL);

		if (manualUrlPicks.length) {
			const url = await askUser(chalk.cyan('Enter a repo URL or local path: '));
			if (url) {
				const resolved = await resolveManualUrl(url, localRepoPaths);
				if (resolved) {
					repoPicks.push(resolved);
					console.log(chalk.green(`  ✓ Resolved: ${path.basename(resolved)} → ${resolved}`));
				} else {
					console.log(chalk.yellow(`  Could not resolve "${url}" to a local repo.`));
				}
			}
		}

		if (!repoPicks.length) throw new Error('No repos selected.');

		await setCached(cacheKey, repoPicks);
		for (const p of repoPicks) {
			repoMap.set(p, p);
			console.log(chalk.green(`  ✓ ${path.basename(p)} → ${p}`));
		}
		return repoMap;
	}

	// --- Step 5: Some matched via URL, but some missing — offer picker for the rest ---
	const alreadyMatched = new Set(repoMap.values());
	const unmatched = localRepoPaths.filter((p) => !alreadyMatched.has(p));

	if (unmatched.length) {
		console.log(chalk.gray('  Select additional local repos, or enter a URL.\n'));

		const unmatchedWithUrl = [...unmatched, MANUAL_URL_SENTINEL];
		const picked = isVoiceModeActive()
			? await pickReposVoiceWithUrl(unmatched, detail.key)
			: await pickReposInteractive(unmatchedWithUrl, `Select additional repo(s) for ${detail.key}`);

		const manualUrlPicks = picked.filter((p) => p === MANUAL_URL_SENTINEL);
		const repoPicks = picked.filter((p) => p !== MANUAL_URL_SENTINEL);

		if (manualUrlPicks.length) {
			const url = await askUser(chalk.cyan('Enter a repo URL or local path: '));
			if (url) {
				const resolved = await resolveManualUrl(url, localRepoPaths);
				if (resolved && !alreadyMatched.has(resolved)) {
					repoPicks.push(resolved);
					console.log(chalk.green(`  ✓ Resolved: ${path.basename(resolved)} → ${resolved}`));
				}
			}
		}

		for (const p of repoPicks) {
			repoMap.set(p, p);
			console.log(chalk.green(`  ✓ ${path.basename(p)} → ${p}`));
		}
	}

	if (!repoMap.size) {
		throw new Error('No repositories resolved. Cannot proceed.');
	}

	await setCached(cacheKey, [...repoMap.values()]);
	return repoMap;
}

export async function resolveRepoPathsAuto(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const repoMap = new Map<string, string>();

	const cacheKey = `repoChoice_${detail.key}`;
	const cached = await getCached<string[]>(cacheKey);
	if (cached?.length) {
		const allValid = cached.every((p) => existsSync(path.join(p, '.git')));
		if (allValid) {
			for (const p of cached) repoMap.set(p, p);
			return repoMap;
		}
	}

	let rootDir = await getCached<string>('rootDir');
	if (!rootDir) {
		rootDir = process.env.FORGEPILOT_ROOT_DIR?.trim() || '';
		if (!rootDir || !existsSync(rootDir)) return repoMap;
	}

	const ticketRepos = extractTicketRepoLabels(detail);
	if (!ticketRepos.length) return repoMap;

	const scanDepth = getRepoScanDepth();
	const localRepoPaths = await scanLocalRepos(rootDir, 0, scanDepth);
	const remoteIndex = new Map<string, string[]>();
	for (const localPath of localRepoPaths) {
		const remotes = await getRemoteUrls(localPath);
		for (const remote of remotes) {
			const localPaths = remoteIndex.get(remote) ?? [];
			localPaths.push(localPath);
			remoteIndex.set(remote, localPaths);
		}
	}

	for (const repo of ticketRepos) {
		const localPath = findMatchingRepo(repo.normalizedUrl, remoteIndex);
		if (localPath) repoMap.set(repo.normalizedUrl, localPath);
	}

	return repoMap;
}

export async function resolveRepoPathsViaSlack(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const ticketRepos = extractTicketRepoLabels(detail);
	const repoMap = new Map<string, string>();

	const rootDir = await getCached<string>('rootDir');
	if (!rootDir) {
		throw new Error('Root directory not cached. Run ForgePilot in terminal first to set it, or set FORGEPILOT_ROOT_DIR.');
	}

	console.log(chalk.gray(`  Scanning repos under ${rootDir}...`));
	const scanDepth = getRepoScanDepth();
	const localRepoPaths = await scanLocalRepos(rootDir, 0, scanDepth);
	console.log(chalk.gray(`  Found ${localRepoPaths.length} local git repo(s).`));

	if (ticketRepos.length) {
		console.log(chalk.gray(`  Found ${ticketRepos.length} repo URL(s) in ticket description. Auto-matching...`));
		const remoteIndex = new Map<string, string[]>();
		for (const localPath of localRepoPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				const localPaths = remoteIndex.get(remote) ?? [];
				localPaths.push(localPath);
				remoteIndex.set(remote, localPaths);
			}
		}

		for (const repo of ticketRepos) {
			const localPath = findMatchingRepo(repo.normalizedUrl, remoteIndex);
			if (localPath) {
				repoMap.set(repo.normalizedUrl, localPath);
				console.log(chalk.green(`  Auto-matched repo: ${repo.label} → ${localPath}`));
			}
		}

		if (repoMap.size > 0) return repoMap;
		console.log(chalk.yellow(`  No auto-matches found.`));
	}

	const cacheKey = `repoChoice_${detail.key}`;
	const cached = await getCached<string[]>(cacheKey);
	if (cached?.length) {
		const allValid = cached.every((p) => existsSync(path.join(p, '.git')));
		if (allValid) {
			for (const p of cached) {
				repoMap.set(p, p);
				console.log(chalk.green(`  Using cached repo: ${path.basename(p)} → ${p}`));
			}
			return repoMap;
		}
	}

	if (!localRepoPaths.length) {
		throw new Error(`No git repos found under ${rootDir}. Cannot resolve repos via Slack.`);
	}

	console.log(chalk.gray(`  Posting repo selection to Slack...`));
	const options: SlackPickOption[] = localRepoPaths.map((p) => ({
		id: p,
		label: `${path.basename(p)} — ${p}`,
	}));

	const selectedPaths = await postAndWaitForSelection(
		`Select repo(s) for *${detail.key}*:`,
		options,
		true,
	);

	if (!selectedPaths.length) throw new Error('No repos selected via Slack.');

	await setCached(cacheKey, selectedPaths);
	for (const p of selectedPaths) {
		repoMap.set(p, p);
		console.log(chalk.green(`  Selected repo: ${path.basename(p)} → ${p} (via Slack)`));
	}

	return repoMap;
}

export async function resolveRepoPathsForMultipleTickets(
	details: JiraIssueDetail[],
): Promise<Map<string, TicketRepoResolution>> {
	const result = new Map<string, TicketRepoResolution>();
	const repoUsageCount = new Map<string, number>();

	const perTicketRepos = new Map<string, Map<string, string>>();
	for (const detail of details) {
		const repoPaths = await resolveRepoPathsFromUser(detail);
		perTicketRepos.set(detail.key, repoPaths);
		for (const repoPath of repoPaths.values()) {
			repoUsageCount.set(repoPath, (repoUsageCount.get(repoPath) ?? 0) + 1);
		}
	}

	const repoFirstClaim = new Set<string>();

	for (const detail of details) {
		const repoPaths = perTicketRepos.get(detail.key)!;
		const needsWorktree = new Set<string>();

		for (const repoPath of repoPaths.values()) {
			const usedByMultiple = (repoUsageCount.get(repoPath) ?? 0) > 1;
			if (usedByMultiple) {
				if (repoFirstClaim.has(repoPath)) {
					needsWorktree.add(repoPath);
				} else {
					repoFirstClaim.add(repoPath);
				}
			}
		}

		result.set(detail.key, { repoPaths, needsWorktree });
	}

	return result;
}
