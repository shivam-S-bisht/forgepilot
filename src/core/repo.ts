import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getCached, setCached } from './cache.js';
import { getDescriptionText } from '../tools/jira/jira-text.js';
import { postAndWaitForSelection } from '../tools/slack/slack.js';
import type { SlackPickOption } from '../tools/slack/slack.js';
import type { JiraIssueDetail, RepoLabel, TicketRepoResolution } from './types.js';
import { renderRepoPicker } from './ui.js';
import { askUser } from './ask.js';

const execFileAsync = promisify(execFile);

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

export async function scanLocalRepos(rootDir: string, depth = 0): Promise<string[]> {
	if (depth > 3) return [];
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	const repos: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
		const full = path.join(rootDir, entry.name);
		if (existsSync(path.join(full, '.git'))) repos.push(full);
		else repos.push(...(await scanLocalRepos(full, depth + 1)));
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

function pickReposInteractive(repos: string[], ticketKey: string): Promise<string[]> {
	return new Promise((resolve) => {
		let cursorIndex = 0;
		const selectedIndices = new Set<number>();

		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);

		renderRepoPicker(repos, cursorIndex, selectedIndices, ticketKey);

		const onKeypress = (_: unknown, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				process.exit(0);
			}

			if (key.name === 'up') {
				cursorIndex = cursorIndex === 0 ? repos.length - 1 : cursorIndex - 1;
				renderRepoPicker(repos, cursorIndex, selectedIndices, ticketKey);
				return;
			}

			if (key.name === 'down') {
				cursorIndex = cursorIndex === repos.length - 1 ? 0 : cursorIndex + 1;
				renderRepoPicker(repos, cursorIndex, selectedIndices, ticketKey);
				return;
			}

			if (key.name === 'space') {
				if (selectedIndices.has(cursorIndex)) selectedIndices.delete(cursorIndex);
				else selectedIndices.add(cursorIndex);
				renderRepoPicker(repos, cursorIndex, selectedIndices, ticketKey);
				return;
			}

			if (key.name === 'return' || key.name === 'enter') {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
				process.stdin.removeListener('keypress', onKeypress);
				const picked = [...selectedIndices].sort().map((i) => repos[i]);
				resolve(picked);
			}
		};

		process.stdin.on('keypress', onKeypress);
	});
}

export async function resolveRepoPathsFromUser(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const description = getDescriptionText(detail);
	const ticketRepos = extractRepoLabels(description);
	const repoMap = new Map<string, string>();

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

	console.log(chalk.gray(`\nScanning repos under ${rootDir} ...`));
	const localRepoPaths = await scanLocalRepos(rootDir);
	console.log(chalk.gray(`  Found ${localRepoPaths.length} local git repo(s).`));

	if (!ticketRepos.length) {
		const cacheKey = `repoChoice_${detail.key}`;
		const cached = await getCached<string[]>(cacheKey);
		if (cached?.length) {
			const allValid = cached.every((p) => existsSync(path.join(p, '.git')));
			if (allValid) {
				console.log(chalk.gray(`Using cached repo selection for ${detail.key}:`));
				for (const p of cached) {
					const name = path.basename(p);
					repoMap.set(name, p);
					console.log(chalk.green(`  ✓ ${name} → ${p}`));
				}
				return repoMap;
			}
		}

		if (!localRepoPaths.length) {
			const manualPath = await askUser('No repos found. Enter the local repo path to work in: ');
			if (!manualPath) throw new Error('No repo path provided.');
			const resolved = path.resolve(manualPath.replace(/^~/, process.env.HOME ?? '~'));
			if (!existsSync(path.join(resolved, '.git'))) throw new Error(`Not a git repository: ${resolved}`);
			repoMap.set('manual', resolved);
			await setCached(cacheKey, [resolved]);
			return repoMap;
		}

		const picked = await pickReposInteractive(localRepoPaths, detail.key);
		if (!picked.length) throw new Error('No repos selected.');

		await setCached(cacheKey, picked);
		for (const p of picked) {
			const name = path.basename(p);
			repoMap.set(name, p);
			console.log(chalk.green(`  ✓ ${name} → ${p}`));
		}
		return repoMap;
	}

	console.log(chalk.bold(`\nFound ${ticketRepos.length} repo URL(s) in ticket description:`));
	for (const repo of ticketRepos) {
		console.log(chalk.cyan(`  ${repo.label} (${repo.normalizedUrl})`));
	}

	const remoteIndex = new Map<string, string>();
	for (const localPath of localRepoPaths) {
		const remotes = await getRemoteUrls(localPath);
		for (const remote of remotes) {
			if (!remoteIndex.has(remote)) remoteIndex.set(remote, localPath);
		}
	}

	const missing: string[] = [];
	for (const repo of ticketRepos) {
		const localPath = remoteIndex.get(repo.normalizedUrl);
		if (localPath) {
			repoMap.set(repo.normalizedUrl, localPath);
			console.log(chalk.green(`  ✓ ${repo.label} → ${localPath}`));
		} else {
			missing.push(repo.label);
			console.log(chalk.yellow(`  ✗ ${repo.label} (${repo.normalizedUrl}) — not found locally`));
		}
	}

	if (missing.length && repoMap.size > 0) {
		console.log(chalk.yellow(`\n  ${missing.length} repo(s) not found locally. Continuing with matched repos.`));
		console.log(chalk.gray('  You can also select additional local repos below.\n'));
	}

	if (missing.length && repoMap.size === 0) {
		console.log(chalk.yellow('\n  None of the ticket repos were found locally.'));
		console.log(chalk.gray('  Please select the correct local repo(s) below.\n'));
	}

	if (missing.length) {
		const cacheKey = `repoChoice_${detail.key}`;
		const cached = await getCached<string[]>(cacheKey);
		if (cached?.length) {
			const allValid = cached.every((p) => existsSync(path.join(p, '.git')));
			if (allValid) {
				console.log(chalk.gray(`Using cached repo selection for missing repos:`));
				for (const p of cached) {
					const name = path.basename(p);
					if (![...repoMap.values()].includes(p)) {
						repoMap.set(name, p);
						console.log(chalk.green(`  ✓ ${name} → ${p}`));
					}
				}
				return repoMap;
			}
		}

		if (localRepoPaths.length) {
			const alreadyMatched = new Set(repoMap.values());
			const unmatched = localRepoPaths.filter((p) => !alreadyMatched.has(p));
			if (unmatched.length) {
				const picked = await pickReposInteractive(unmatched, detail.key);
				if (picked.length) {
					await setCached(cacheKey, picked);
					for (const p of picked) {
						const name = path.basename(p);
						repoMap.set(name, p);
						console.log(chalk.green(`  ✓ ${name} → ${p}`));
					}
				}
			}
		} else {
			const manualPath = await askUser('No local repos found. Enter the repo path manually: ');
			if (manualPath) {
				const resolved = path.resolve(manualPath.replace(/^~/, process.env.HOME ?? '~'));
				if (existsSync(path.join(resolved, '.git'))) {
					repoMap.set('manual', resolved);
					await setCached(`repoChoice_${detail.key}`, [resolved]);
				}
			}
		}
	}

	if (!repoMap.size) {
		throw new Error('No repositories resolved. Cannot proceed.');
	}

	return repoMap;
}

export async function resolveRepoPathsAuto(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const repoMap = new Map<string, string>();

	const cacheKey = `repoChoice_${detail.key}`;
	const cached = await getCached<string[]>(cacheKey);
	if (cached?.length) {
		const allValid = cached.every((p) => existsSync(path.join(p, '.git')));
		if (allValid) {
			for (const p of cached) repoMap.set(path.basename(p), p);
			return repoMap;
		}
	}

	let rootDir = await getCached<string>('rootDir');
	if (!rootDir) {
		rootDir = process.env.FORGEPILOT_ROOT_DIR?.trim() || '';
		if (!rootDir || !existsSync(rootDir)) return repoMap;
	}

	const description = getDescriptionText(detail);
	const ticketRepos = extractRepoLabels(description);
	if (!ticketRepos.length) return repoMap;

	const localRepoPaths = await scanLocalRepos(rootDir);
	const remoteIndex = new Map<string, string>();
	for (const localPath of localRepoPaths) {
		const remotes = await getRemoteUrls(localPath);
		for (const remote of remotes) {
			if (!remoteIndex.has(remote)) remoteIndex.set(remote, localPath);
		}
	}

	for (const repo of ticketRepos) {
		const localPath = remoteIndex.get(repo.normalizedUrl);
		if (localPath) repoMap.set(repo.normalizedUrl, localPath);
	}

	return repoMap;
}

export async function resolveRepoPathsViaSlack(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const description = getDescriptionText(detail);
	const ticketRepos = extractRepoLabels(description);
	const repoMap = new Map<string, string>();

	const rootDir = await getCached<string>('rootDir');
	if (!rootDir) {
		throw new Error('Root directory not cached. Run ForgePilot in terminal first to set it, or set FORGEPILOT_ROOT_DIR.');
	}

	console.log(chalk.gray(`  Scanning repos under ${rootDir}...`));
	const localRepoPaths = await scanLocalRepos(rootDir);
	console.log(chalk.gray(`  Found ${localRepoPaths.length} local git repo(s).`));

	if (ticketRepos.length) {
		console.log(chalk.gray(`  Found ${ticketRepos.length} repo URL(s) in ticket description. Auto-matching...`));
		const remoteIndex = new Map<string, string>();
		for (const localPath of localRepoPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				if (!remoteIndex.has(remote)) remoteIndex.set(remote, localPath);
			}
		}

		for (const repo of ticketRepos) {
			const localPath = remoteIndex.get(repo.normalizedUrl);
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
				repoMap.set(path.basename(p), p);
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
		repoMap.set(path.basename(p), p);
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
