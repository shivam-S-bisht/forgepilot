import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

let axonActivated = false;

/**
 * Ensures axon is available in PATH for the current process and all children.
 * If axon is already in PATH, returns true immediately.
 * Otherwise, reads FORGEPILOT_AXON_VENV_PATH and prepends its bin/ to PATH.
 */
export function activateAxonVenv(): boolean {
	if (axonActivated) return true;

	try {
		execFileSync('command', ['-v', 'axon'], { shell: true, stdio: 'ignore' });
		axonActivated = true;
		return true;
	} catch {
		// Not in PATH, try venv.
	}

	const venvPath = process.env.FORGEPILOT_AXON_VENV_PATH?.trim();
	if (!venvPath) return false;

	const resolved = venvPath.replace(/^~/, process.env.HOME ?? '~');
	const venvBin = path.join(resolved, 'bin');
	if (!existsSync(path.join(venvBin, 'axon'))) return false;

	process.env.PATH = `${venvBin}:${process.env.PATH}`;
	axonActivated = true;
	return true;
}

function isAxonAvailable(): boolean {
	return activateAxonVenv();
}

function hasAxonGraph(repoPath: string): boolean {
	return existsSync(path.join(repoPath, '.axon'));
}

export function startAxonWatch(repoPath: string): ChildProcess | null {
	if (!hasAxonGraph(repoPath)) return null;
	if (!isAxonAvailable()) return null;

	const repoName = path.basename(repoPath);
	console.log(chalk.cyan(`  Initializing Axon knowledge graph for ${repoName}...`));

	try {
		const child = spawn('axon', ['watch', '.'], {
			cwd: repoPath,
			stdio: 'ignore',
			detached: true,
		});
		child.unref();
		console.log(chalk.green(`  ✓ Axon watch mode activated (PID: ${child.pid})`));
		return child;
	} catch {
		console.log(chalk.yellow('  ⚠ Could not start Axon watch — structural reasoning will use static graph only.'));
		return null;
	}
}

export function stopAxonWatch(child: ChildProcess | null): void {
	if (!child) return;
	try {
		if (child.pid) process.kill(-child.pid, 'SIGTERM');
	} catch {
		try {
			child.kill('SIGTERM');
		} catch {
			// Already exited.
		}
	}
	console.log(chalk.gray('  Axon watch stopped.'));
}

export function getAxonPromptHint(repoPath: string): string {
	if (!hasAxonGraph(repoPath)) return '';
	if (!isAxonAvailable()) return '';
	return [
		'',
		'--- AXON STRUCTURAL REASONING PROTOCOL ---',
		'',
		'This repository includes a precomputed Axon knowledge graph in `.axon/`.',
		'The graph contains call graphs, type dependencies, execution flows, community clusters, and git coupling.',
		'',
		'You MUST follow this workflow whenever analyzing or modifying code:',
		'',
		'STEP 1 — Structural Context',
		'Before answering anything about code, call:',
		'axon_context(<relevant symbol or file>)',
		'',
		'STEP 2 — Impact Analysis',
		'Before proposing edits, refactors, deletions, or type changes, call:',
		'axon_impact(<symbol>)',
		'',
		'STEP 3 — Architecture Awareness',
		'If the task involves system behavior, routing, logic location, or design decisions:',
		'call axon_query("<concept>") to identify execution flows and communities.',
		'',
		'STEP 4 — Safety Checks',
		'Before deleting or replacing code:',
		'call axon_dead_code and confirm the symbol is safe to remove.',
		'',
		'Rules:',
		'- Never rely only on text search when Axon tools are available.',
		'- Prefer graph results over assumptions.',
		'- If graph data contradicts code reading, trust graph structure.',
		'- Always mention impacted symbols before suggesting code changes.',
		'',
		'Available tools:',
		'axon_query("...") → hybrid semantic + structural search grouped by execution flow',
		'axon_context(SYMBOL) → full structural view',
		'axon_impact(SYMBOL) → blast radius',
		'axon_dead_code → unreachable symbols',
		'',
		'Goal:',
		'Act like a staff engineer who understands the entire architecture, not just visible files.',
		'',
		'CRITICAL: You MUST use Axon tools (axon_context, axon_impact, axon_query) BEFORE making any code changes.',
		'Do NOT skip Axon lookups — they are mandatory, not optional.',
		'If you proceed without consulting the Axon graph first, your changes may break downstream dependencies.',
		'Every todo item implementation should begin with an axon_context or axon_query call to understand the affected area.',
		'',
		'--- END AXON PROTOCOL ---',
	].join('\n');
}

export function logAxonStatus(repoPath: string): void {
	if (!hasAxonGraph(repoPath)) return;
	if (isAxonAvailable()) {
		console.log(chalk.green('  ✓ Axon knowledge graph detected — structural reasoning protocol injected into agent prompt.'));
	} else {
		console.log(chalk.yellow('  ⚠ Axon graph found at .axon/ but axon binary not available. Set FORGEPILOT_AXON_VENV_PATH.'));
	}
}
