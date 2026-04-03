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

	// Install commit-msg hook to strip AI tool trailers
	await installCommitMsgHook(wtPath);

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

export function getSubAgentWorktreePath(repoPath: string, ticketKey: string, subIndex: number): string {
	const repoName = path.basename(repoPath);
	return path.join(getWorktreeBaseDir(), `${repoName}--${ticketKey.toUpperCase()}-sub${subIndex + 1}`);
}

export async function createSubAgentWorktree(
	repoPath: string,
	ticketKey: string,
	subIndex: number,
	parentBranch: string,
): Promise<string> {
	const subBranch = `${ticketKey.toUpperCase()}-sub${subIndex + 1}`;
	const wtPath = getSubAgentWorktreePath(repoPath, ticketKey, subIndex);

	await fs.mkdir(path.dirname(wtPath), { recursive: true });

	if (existsSync(wtPath)) {
		console.log(chalk.gray(`  Sub-agent worktree ${wtPath} already exists, removing...`));
		try {
			await gitExec(repoPath, ['worktree', 'remove', wtPath, '--force']);
		} catch { /* ignore */ }
		if (await branchExists(repoPath, subBranch)) {
			try { await gitExec(repoPath, ['branch', '-D', subBranch]); } catch { /* ignore */ }
		}
	}

	if (await branchExists(repoPath, subBranch)) {
		try { await gitExec(repoPath, ['branch', '-D', subBranch]); } catch { /* ignore */ }
	}

	console.log(chalk.gray(`  Creating sub-agent worktree: ${subBranch} from ${parentBranch}`));
	await gitExec(repoPath, ['worktree', 'add', '-b', subBranch, wtPath, parentBranch]);

	const axonSource = path.join(repoPath, '.axon');
	const axonTarget = path.join(wtPath, '.axon');
	if (existsSync(axonSource) && !existsSync(axonTarget)) {
		try { await fs.symlink(axonSource, axonTarget); } catch { /* ignore */ }
	}

	// Install commit-msg hook to strip AI tool trailers
	await installCommitMsgHook(wtPath);

	return wtPath;
}

export type SubAgentBranchAnalysis = {
	subBranch: string;
	index: number;
	exists: boolean;
	aheadCommits: Array<{ hash: string; message: string }>;
	hasUncommittedChanges: boolean;
	uncommittedFiles: string[];
	alreadyMerged: boolean;
};

export type EnhancedMergeResult = {
	merged: number;
	conflicts: string[];
	branchAnalyses: SubAgentBranchAnalysis[];
	mainBranchStashed: boolean;
};

export async function analyzeSubAgentWork(
	repoPath: string,
	ticketKey: string,
	subIndices: number[],
	mainBranch: string,
): Promise<SubAgentBranchAnalysis[]> {
	const analyses: SubAgentBranchAnalysis[] = [];

	for (const idx of subIndices) {
		const subBranch = `${ticketKey.toUpperCase()}-sub${idx + 1}`;
		const wtPath = getSubAgentWorktreePath(repoPath, ticketKey, idx);

		const analysis: SubAgentBranchAnalysis = {
			subBranch,
			index: idx,
			exists: false,
			aheadCommits: [],
			hasUncommittedChanges: false,
			uncommittedFiles: [],
			alreadyMerged: false,
		};

		if (!(await branchExists(repoPath, subBranch))) {
			analyses.push(analysis);
			continue;
		}

		analysis.exists = true;

		// Check commits ahead of main branch
		try {
			const logOutput = await gitExec(repoPath, ['log', `${mainBranch}..${subBranch}`, '--oneline', '--no-decorate']);
			if (logOutput.trim()) {
				analysis.aheadCommits = logOutput.trim().split('\n').map((line) => {
					const spaceIdx = line.indexOf(' ');
					return {
						hash: spaceIdx > 0 ? line.substring(0, spaceIdx) : line,
						message: spaceIdx > 0 ? line.substring(spaceIdx + 1) : '',
					};
				});
			} else {
				// No commits ahead — already merged or no changes
				analysis.alreadyMerged = true;
			}
		} catch {
			// If log fails, treat as needing investigation
		}

		// Check for uncommitted changes in the worktree
		if (existsSync(wtPath)) {
			try {
				const statusOutput = await gitExec(wtPath, ['status', '--porcelain']);
				if (statusOutput.trim()) {
					analysis.hasUncommittedChanges = true;
					analysis.uncommittedFiles = statusOutput.trim().split('\n').map((l) => l.trim());
				}
			} catch { /* worktree may not be accessible */ }
		}

		analyses.push(analysis);
	}

	return analyses;
}

/**
 * Install a commit-msg git hook that strips unwanted trailers
 * (e.g. "Made by Cursor", "Generated by …") from every commit at write time.
 * This is idempotent — safe to call multiple times on the same repo.
 */
export async function installCommitMsgHook(repoOrWorktreePath: string): Promise<void> {
	// For worktrees, hooks live in the main repo's .git/hooks by default,
	// but we can set core.hooksPath to a local hooks dir in the worktree.
	// Alternatively, we find the actual git dir.
	let hooksDir: string;
	try {
		const gitDir = await gitExec(repoOrWorktreePath, ['rev-parse', '--git-dir']);
		hooksDir = path.join(
			path.isAbsolute(gitDir) ? gitDir : path.join(repoOrWorktreePath, gitDir),
			'hooks',
		);
	} catch {
		hooksDir = path.join(repoOrWorktreePath, '.git', 'hooks');
	}

	await fs.mkdir(hooksDir, { recursive: true });

	const hookPath = path.join(hooksDir, 'commit-msg');

	// The hook script: strips known AI tool trailers from the commit message file
	const hookScript = `#!/bin/sh
# ForgePilot: strip AI tool trailers from commit messages
if [ -f "$1" ]; then
  sed -i.bak \\
    -e '/^Made-with:.*[Cc]ursor/d' \\
    -e '/^Made by Cursor/d' \\
    -e '/^Made-with:.*[Cc]opilot/d' \\
    -e '/^Generated by /d' \\
    -e '/^Co-authored-by:.*[Cc]ursor/d' \\
    -e '/^Signed-off-by:.*[Cc]ursor/d' \\
    -e '/^Co-authored-by:.*[Cc]opilot/d' \\
    -e '/^Signed-off-by:.*[Cc]opilot/d' \\
    "$1"
  # Remove trailing blank lines
  sed -i.bak -e :a -e '/^\\n*$/{$d;N;ba' -e '}' "$1"
  rm -f "$1.bak"
fi
`;

	// Check if hook already exists and has our marker with current patterns
	try {
		const existing = await fs.readFile(hookPath, 'utf8');
		if (existing.includes('ForgePilot: strip AI tool trailers') && existing.includes('Made-with:')) return; // up-to-date

		if (existing.includes('ForgePilot: strip AI tool trailers')) {
			// Old version without Made-with pattern — overwrite with updated version
			await fs.writeFile(hookPath, hookScript, { mode: 0o755 });
			return;
		}

		// There's an existing hook — prepend our logic before it
		const merged = hookScript + '\n# --- Original hook below ---\n' + existing.replace(/^#!.*\n/, '');
		await fs.writeFile(hookPath, merged, { mode: 0o755 });
	} catch {
		// No existing hook — write ours
		await fs.writeFile(hookPath, hookScript, { mode: 0o755 });
	}
}

/** @deprecated Use installCommitMsgHook instead — this rebase approach is fragile. */
export async function stripCommitTrailers(
	repoPath: string,
	subBranch: string,
	mainBranch: string,
): Promise<number> {
	const TRAILER_RE = /(?:Made-with:.*[Cc]ursor|Made by Cursor|Generated by |Co-authored-by:.*[Cc]ursor|Signed-off-by:.*[Cc]ursor)/;

	try {
		const logOutput = await gitExec(repoPath, [
			'log', `${mainBranch}..${subBranch}`, '--format=%H%n%B', '--reverse',
		]);
		if (!logOutput.trim()) return 0;

		// Quick check: does any commit even have a trailer?
		if (!TRAILER_RE.test(logOutput)) return 0;

		await gitExec(repoPath, ['checkout', subBranch]);

		// sed command that strips the trailer lines and collapses trailing blank lines
		const sedFilter = [
			'/^Made-with:.*[Cc]ursor/d',
			'/^Made by Cursor/d',
			'/^Generated by /d',
			'/^Co-authored-by:.*[Cc]ursor/d',
			'/^Signed-off-by:.*[Cc]ursor/d',
		].join('; ');

		// Non-interactive rebase with --exec: amend each commit's message via sed
		const amendCmd = `git log -1 --format=%B HEAD | sed '${sedFilter}' | sed -e :a -e '/^\\n*$/{$d;N;ba' -e '}' > /tmp/.fp-msg && git commit --amend -F /tmp/.fp-msg --no-verify`;

		await execFileAsync('git', [
			'-C', repoPath,
			'rebase', mainBranch,
			'--exec', amendCmd,
		], { maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_SEQUENCE_EDITOR: ':' } });

		// Count how many were actually changed (rough — we know at least one was)
		console.log(chalk.gray(`  Stripped trailers from commits on ${subBranch}`));
		return 1;
	} catch {
		// If anything goes wrong, abort the rebase and carry on
		try { await gitExec(repoPath, ['rebase', '--abort']); } catch { /* ignore */ }
		return 0;
	}
}

export async function mergeSubAgentBranches(
	repoPath: string,
	ticketKey: string,
	subIndices: number[],
	mainBranch: string,
): Promise<EnhancedMergeResult> {
	// Step 1: Analyze all sub-agent branches before any merge operations
	const branchAnalyses = await analyzeSubAgentWork(repoPath, ticketKey, subIndices, mainBranch);

	// Step 2: Stash ALL uncommitted + untracked changes (including .forgepilot md files)
	// instead of deleting them — this preserves any in-progress main branch state
	let mainBranchStashed = false;
	try {
		const statusOutput = await gitExec(repoPath, ['status', '--porcelain']);
		// Also check for untracked forgepilot files that would block merge
		const entries = await fs.readdir(repoPath).catch(() => [] as string[]);
		const hasForgepilotFiles = entries.some((e) =>
			(e.startsWith('.forgepilot-todos-') || e.startsWith('.forgepilot-questions-') || e.startsWith('.forgepilot-answers-'))
			&& e.endsWith('.md'),
		);

		if (statusOutput.trim() || hasForgepilotFiles) {
			// Stage any untracked forgepilot files so they get included in the stash
			if (hasForgepilotFiles) {
				for (const entry of entries) {
					if (
						(entry.startsWith('.forgepilot-todos-') || entry.startsWith('.forgepilot-questions-') || entry.startsWith('.forgepilot-answers-'))
						&& entry.endsWith('.md')
					) {
						try { await gitExec(repoPath, ['add', entry]); } catch { /* ignore */ }
					}
				}
			}
			await gitExec(repoPath, ['stash', 'push', '-u', '-m', `forgepilot-pre-merge-${ticketKey}`]);
			mainBranchStashed = true;
			console.log(chalk.gray('  Stashed main branch changes (including forgepilot temp files) before merge'));
		}
	} catch { /* ignore — may fail if nothing to stash */ }

	await gitExec(repoPath, ['checkout', mainBranch]);

	let merged = 0;
	const conflicts: string[] = [];

	console.log(chalk.bold.cyan(`\n  Merging ${subIndices.length} sub-agent branches into ${mainBranch}...\n`));

	for (const analysis of branchAnalyses) {
		if (!analysis.exists) {
			console.log(chalk.gray(`  ${analysis.subBranch}: branch not found — skipping`));
			continue;
		}

		if (analysis.alreadyMerged) {
			console.log(chalk.gray(`  ${analysis.subBranch}: already merged — skipping`));
			continue;
		}

		if (analysis.aheadCommits.length === 0) {
			console.log(chalk.gray(`  ${analysis.subBranch}: no new commits — skipping`));
			continue;
		}

		console.log(chalk.gray(`  ${analysis.subBranch}: ${analysis.aheadCommits.length} commit(s) to merge`));

		try {
			await gitExec(repoPath, ['merge', analysis.subBranch, '--no-edit', '-m', `Merge sub-agent (${analysis.subBranch})`]);
			merged++;
			console.log(chalk.green(`  ✓ Merged ${analysis.subBranch} into ${mainBranch}`));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('CONFLICT') || msg.includes('conflict')) {
				console.log(chalk.yellow(`  ⚠ Merge conflict from ${analysis.subBranch} — aborting this merge`));
				try { await gitExec(repoPath, ['merge', '--abort']); } catch { /* ignore */ }
				conflicts.push(analysis.subBranch);
			} else {
				console.log(chalk.red(`  ✗ Failed to merge ${analysis.subBranch}: ${msg}`));
				try { await gitExec(repoPath, ['merge', '--abort']); } catch { /* ignore */ }
				conflicts.push(analysis.subBranch);
			}
		}
	}

	// Step 5: Restore stashed changes (but NOT forgepilot temp files — they get reconciled separately)
	if (mainBranchStashed) {
		try {
			await gitExec(repoPath, ['stash', 'pop']);
			console.log(chalk.gray('  Restored stashed changes on main branch'));
		} catch {
			// Pop may conflict if merge brought in the same files.
			// Drop the stash — the merged state is the authoritative one.
			console.log(chalk.yellow('  ⚠ Stash pop conflict — dropping stash (merged state takes priority).'));
			try { await gitExec(repoPath, ['checkout', '--', '.']); } catch { /* ignore */ }
			try { await gitExec(repoPath, ['stash', 'drop']); } catch { /* ignore */ }
		}
	}

	// Report uncommitted changes in sub-agent worktrees
	const withUncommitted = branchAnalyses.filter((a) => a.hasUncommittedChanges);
	if (withUncommitted.length > 0) {
		console.log(chalk.yellow(`\n  ⚠ ${withUncommitted.length} sub-agent(s) have uncommitted changes in their worktrees:`));
		for (const a of withUncommitted) {
			const wtPath = getSubAgentWorktreePath(repoPath, ticketKey, a.index);
			console.log(chalk.yellow(`    ${a.subBranch} → ${wtPath}`));
			for (const f of a.uncommittedFiles.slice(0, 5)) {
				console.log(chalk.gray(`      ${f}`));
			}
			if (a.uncommittedFiles.length > 5) {
				console.log(chalk.gray(`      ... and ${a.uncommittedFiles.length - 5} more`));
			}
		}
	}

	return { merged, conflicts, branchAnalyses, mainBranchStashed };
}

const FORGEPILOT_MD_PATTERNS = ['.forgepilot-todos-', '.forgepilot-questions-', '.forgepilot-answers-'];

function isForgepilotTempFile(filename: string): boolean {
	return FORGEPILOT_MD_PATTERNS.some((p) => filename.startsWith(p)) && filename.endsWith('.md');
}

/** Check if a sub-agent worktree's md files were recently modified (agent may still be finishing). */
async function isWorktreeRecentlyActive(wtPath: string, ticketKey: string, thresholdMs = 15_000): Promise<boolean> {
	const safeKey = ticketKey.toUpperCase().replace(/[/\\]/g, '-');
	const mdFiles = [
		path.join(wtPath, `.forgepilot-todos-${safeKey}.md`),
		path.join(wtPath, `.forgepilot-questions-${safeKey}.md`),
		path.join(wtPath, `.forgepilot-answers-${safeKey}.md`),
	];

	for (const mdFile of mdFiles) {
		try {
			const stat = await fs.stat(mdFile);
			const age = Date.now() - stat.mtimeMs;
			if (age < thresholdMs) return true;
		} catch { /* file doesn't exist — fine */ }
	}
	return false;
}

export async function cleanupSubAgentWorktrees(
	repoPath: string,
	ticketKey: string,
	subIndices: number[],
): Promise<void> {
	const skipped: number[] = [];

	for (const idx of subIndices) {
		const wtPath = getSubAgentWorktreePath(repoPath, ticketKey, idx);
		const subBranch = `${ticketKey.toUpperCase()}-sub${idx + 1}`;

		// Check if the worktree md files were recently modified — agent may still be flushing
		if (existsSync(wtPath) && await isWorktreeRecentlyActive(wtPath, ticketKey)) {
			console.log(chalk.yellow(`  ⚠ Worktree ${subBranch}: md files recently modified — waiting...`));
			// Wait briefly for the agent to finish flushing
			await new Promise((r) => setTimeout(r, 5000));

			// Re-check after wait
			if (await isWorktreeRecentlyActive(wtPath, ticketKey, 5000)) {
				console.log(chalk.yellow(`  ⚠ Worktree ${subBranch}: still active — skipping cleanup`));
				skipped.push(idx);
				continue;
			}
		}

		try {
			await gitExec(repoPath, ['worktree', 'remove', wtPath, '--force']);
		} catch { /* ignore */ }
		// Remove leftover directory if git worktree remove didn't fully clean up
		try {
			await fs.rm(wtPath, { recursive: true, force: true });
		} catch { /* ignore */ }
		try {
			await gitExec(repoPath, ['branch', '-D', subBranch]);
		} catch { /* ignore */ }
	}
	// Prune stale worktree entries
	try {
		await gitExec(repoPath, ['worktree', 'prune']);
	} catch { /* ignore */ }

	const cleaned = subIndices.length - skipped.length;
	if (skipped.length > 0) {
		console.log(chalk.yellow(`  Cleaned ${cleaned} worktrees, skipped ${skipped.length} (still active)`));
	} else {
		console.log(chalk.gray(`  Cleaned up ${cleaned} sub-agent worktrees/branches`));
	}
}

/** Remove all .forgepilot-todos/questions/answers md files from a repo root. Call at the very end. */
export async function cleanupForgepilotTempFiles(repoPath: string): Promise<void> {
	try {
		const entries = await fs.readdir(repoPath);
		let removed = 0;
		for (const entry of entries) {
			if (isForgepilotTempFile(entry)) {
				await fs.rm(path.join(repoPath, entry), { force: true });
				removed++;
			}
		}
		// Also unstage them from git index if tracked
		if (removed > 0) {
			try { await gitExec(repoPath, ['rm', '--cached', '--ignore-unmatch', '.forgepilot-*.md']); } catch { /* ignore */ }
			console.log(chalk.gray(`  Cleaned up ${removed} forgepilot temp file(s) from ${path.basename(repoPath)}`));
		}
	} catch { /* best-effort */ }
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

	// Install commit-msg hook to strip AI tool trailers
	await installCommitMsgHook(repoPath);

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

// ---------------------------------------------------------------------------
// Completion summary — gathers git stats for a ticket branch
// ---------------------------------------------------------------------------

export interface TicketCompletionSummary {
	ticketKey: string;
	repoPath: string;
	repoName: string;
	commitCount: number;
	commitLog: string;
	diffStat: string;
	fileList: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	aiSummary?: string;
}

export async function generateCompletionSummary(
	repoPath: string,
	ticketKey: string,
): Promise<TicketCompletionSummary> {
	const baseBranch = getBaseBranch();
	const repoName = path.basename(repoPath);

	let commitLog = '';
	try {
		commitLog = await gitExec(repoPath, ['log', `${baseBranch}..HEAD`, '--oneline']);
	} catch {
		try {
			commitLog = await gitExec(repoPath, ['log', '--oneline', '-20']);
		} catch {
			commitLog = '';
		}
	}
	const commitCount = commitLog.split('\n').filter(Boolean).length;

	let diffStat = '';
	try {
		diffStat = await gitExec(repoPath, ['diff', '--stat', `${baseBranch}...HEAD`]);
	} catch {
		try {
			diffStat = await gitExec(repoPath, ['diff', '--stat', 'HEAD~5..HEAD']);
		} catch {
			diffStat = '';
		}
	}

	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	try {
		const shortstat = await gitExec(repoPath, ['diff', '--shortstat', `${baseBranch}...HEAD`]);
		const filesMatch = shortstat.match(/(\d+)\s+files?\s+changed/);
		const insMatch = shortstat.match(/(\d+)\s+insertions?/);
		const delMatch = shortstat.match(/(\d+)\s+deletions?/);
		if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);
		if (insMatch) insertions = parseInt(insMatch[1], 10);
		if (delMatch) deletions = parseInt(delMatch[1], 10);
	} catch {
		// Best-effort; stats may not be available.
	}

	let fileList = '';
	try {
		fileList = await gitExec(repoPath, ['diff', '--name-only', `${baseBranch}...HEAD`]);
	} catch {
		// Best-effort.
	}

	return {
		ticketKey,
		repoPath,
		repoName,
		commitCount,
		commitLog,
		diffStat,
		fileList,
		filesChanged,
		insertions,
		deletions,
	};
}

export function formatCompletionSummaryText(summaries: TicketCompletionSummary[]): string {
	if (summaries.length === 0) return '';
	const ticketKey = summaries[0].ticketKey;

	// If any summary has an AI-generated overview, use that
	const hasAi = summaries.some((s) => s.aiSummary);
	if (hasAi) {
		const lines: string[] = [`ForgePilot work summary for ${ticketKey}:`];
		for (const s of summaries) {
			if (summaries.length > 1) lines.push(`\nRepo: ${s.repoName}`);
			if (s.aiSummary) {
				lines.push(s.aiSummary);
			} else {
				lines.push(`  ${s.commitCount} commit(s) | ${s.filesChanged} file(s) changed | +${s.insertions} −${s.deletions}`);
			}
		}
		return lines.join('\n');
	}

	// Fallback: raw stats
	const lines: string[] = [`ForgePilot work summary for ${ticketKey}:`];
	for (const s of summaries) {
		if (summaries.length > 1) lines.push(`\nRepo: ${s.repoName}`);
		lines.push(`  ${s.commitCount} commit(s) | ${s.filesChanged} file(s) changed | +${s.insertions} −${s.deletions}`);
		if (s.fileList) {
			const files = s.fileList.split('\n').filter(Boolean).slice(0, 20);
			for (const f of files) lines.push(`  • ${f}`);
			if (s.fileList.split('\n').filter(Boolean).length > 20) lines.push('  … and more');
		}
	}
	return lines.join('\n');
}

export function buildSummaryPrompt(summaries: TicketCompletionSummary[]): string {
	if (summaries.length === 0) return '';
	const ticketKey = summaries[0].ticketKey;

	const sections: string[] = [
		`Summarize the following code changes made for Jira ticket ${ticketKey}.`,
		'',
		'Output requirements:',
		'- Start with a 2-3 sentence functional overview of what was accomplished.',
		'- List key files changed and briefly describe what was modified in each (group by feature/area).',
		'- Highlight major functionality added, changed, or fixed.',
		'- Do NOT list raw commit hashes or repeat commit messages verbatim.',
		'- Keep it concise and useful for a code reviewer or stakeholder.',
		'- Use plain text, no markdown formatting.',
		'',
	];

	for (const s of summaries) {
		if (summaries.length > 1) sections.push(`--- Repo: ${s.repoName} ---`);
		sections.push(`Stats: ${s.commitCount} commit(s), ${s.filesChanged} file(s) changed, +${s.insertions} −${s.deletions}`);
		if (s.commitLog) {
			sections.push('', 'Commit messages:', s.commitLog);
		}
		if (s.fileList) {
			sections.push('', 'Files changed:', s.fileList);
		}
		if (s.diffStat) {
			sections.push('', 'Diff stats:', s.diffStat);
		}
	}

	return sections.join('\n');
}
