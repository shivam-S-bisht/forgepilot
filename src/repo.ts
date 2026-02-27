import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getCached, setCached } from './cache.js';
import { getDescriptionText } from './jira-text.js';
import type { JiraIssueDetail, RepoLabel } from './types.js';

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

function askLine(prompt: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) =>
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		}),
	);
}

export async function resolveRepoPathsFromUser(detail: JiraIssueDetail): Promise<Map<string, string>> {
	const description = getDescriptionText(detail);
	const ticketRepos = extractRepoLabels(description);
	const repoMap = new Map<string, string>();

	let rootDir = await getCached<string>('rootDir');
	if (!rootDir) {
		const input = await askLine('Root directory containing your repos (e.g. ~/dev): ');
		if (!input) throw new Error('Root directory is required.');
		rootDir = path.resolve(input.replace(/^~/, process.env.HOME ?? '~'));
		if (!existsSync(rootDir)) throw new Error(`Directory does not exist: ${rootDir}`);
		await setCached('rootDir', rootDir);
	} else {
		console.log(chalk.gray(`Using cached root directory: ${rootDir}`));
	}

	if (!ticketRepos.length) {
		console.log(chalk.yellow('\nNo repository URLs found in ticket description.'));
		const manualPath = await askLine('Enter the local repo path to work in: ');
		if (!manualPath) throw new Error('No repo path provided.');
		const resolved = path.resolve(manualPath.replace(/^~/, process.env.HOME ?? '~'));
		if (!existsSync(path.join(resolved, '.git'))) throw new Error(`Not a git repository: ${resolved}`);
		repoMap.set('manual', resolved);
		return repoMap;
	}

	console.log(chalk.bold(`\nFound ${ticketRepos.length} repo URL(s) in ticket description:`));
	for (const repo of ticketRepos) {
		console.log(chalk.cyan(`  ${repo.label} (${repo.normalizedUrl})`));
	}

	console.log(chalk.gray(`\nScanning repos under ${rootDir} ...`));
	const localRepoPaths = await scanLocalRepos(rootDir);
	console.log(chalk.gray(`  Found ${localRepoPaths.length} local git repo(s).`));

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
			console.log(chalk.red(`  ✗ ${repo.label} (${repo.normalizedUrl}) — not found locally`));
		}
	}

	if (missing.length) {
		throw new Error(
			`Could not find local repos for: ${missing.join(', ')}. Make sure they are cloned under ${rootDir}.`,
		);
	}

	return repoMap;
}
