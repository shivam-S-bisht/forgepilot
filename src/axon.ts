import { existsSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

// When FORGEPILOT_AXON_ENABLED=true we assume the graph is already built (axon analyze .) and lives in .axon/ at repo root.
// We only inject a prompt hint so the agent uses the graph; we do not run any axon command.

function isAxonEnabled(): boolean {
	return (process.env.FORGEPILOT_AXON_ENABLED ?? 'false').trim().toLowerCase() === 'true';
}

export function getAxonPromptHint(repoPath: string): string {
	if (!isAxonEnabled()) return '';
	const axonDir = path.join(repoPath, '.axon');
	if (!existsSync(axonDir)) return '';
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
		'--- END AXON PROTOCOL ---',
	].join('\n');
}

export function logAxonStatus(repoPath: string): void {
	if (!isAxonEnabled()) return;
	const axonDir = path.join(repoPath, '.axon');
	if (existsSync(axonDir)) {
		console.log(chalk.gray('  Axon graph found at .axon/ — hint added to agent prompt.'));
	}
}
