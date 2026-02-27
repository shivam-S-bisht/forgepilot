import { execFile } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { commentsText, getAcceptanceCriteria, getDescriptionText, linkedIssuesText } from './jira-text.js';
import { extractRepoLabels } from './repo.js';
import type { JiraIssueDetail } from './types.js';

const execFileAsync = promisify(execFile);

export type PreflightConcern = {
	id: string;
	severity: 'warning' | 'question';
	message: string;
	hint?: string;
};

export type PreflightResult = {
	concerns: PreflightConcern[];
	answers: Map<string, string>;
};

function askLine(prompt: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) =>
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		}),
	);
}

function trimForPrompt(value: string, max = 5000): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n... (truncated)`;
}

function buildAiPreflightPrompt(detail: JiraIssueDetail, hasContributing: boolean): string {
	const title = detail.fields.summary ?? '(no title)';
	const status = detail.fields.status?.name ?? 'Unknown';
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const comments = commentsText(detail);
	const links = linkedIssuesText(detail);
	const repoUrls = extractRepoLabels(description).map((x) => x.normalizedUrl);

	return [
		'You are a Jira ticket preflight reviewer for a coding agent.',
		'Find ambiguities, contradictions, missing context, risks, and reasons to not start work.',
		'',
		'Output requirements:',
		'- Return ONLY valid JSON (no markdown, no explanation).',
		'- Schema: {"concerns":[{"id":"string","severity":"warning|question","message":"string","hint":"string"}]}',
		'- Max 6 concerns.',
		'- Include concern(s) if ticket appears blocked/flagged/deferred/do-not-pick/requires dependency.',
		'- Include concern(s) if description, AC, and comments conflict.',
		'- Include concern(s) for missing repos, missing coding conventions, unclear scope, missing test expectations.',
		'',
		`Ticket Key: ${detail.key}`,
		`Title: ${title}`,
		`Status: ${status}`,
		`HasContributingOrAgents: ${hasContributing ? 'yes' : 'no'}`,
		`RepoUrlsInDescription: ${repoUrls.length ? repoUrls.join(', ') : '(none)'}`,
		'',
		`Description:\n${trimForPrompt(description, 6000)}`,
		'',
		`Acceptance Criteria:\n${trimForPrompt(ac, 4000)}`,
		'',
		`Linked Issues:\n${trimForPrompt(links, 3000)}`,
		'',
		`Comments:\n${trimForPrompt(comments, 6000)}`,
	].join('\n');
}

function extractJsonPayload(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// Continue with best-effort extraction.
	}

	const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		return JSON.parse(fenced[1]);
	}

	const firstObj = raw.indexOf('{');
	const lastObj = raw.lastIndexOf('}');
	if (firstObj >= 0 && lastObj > firstObj) {
		return JSON.parse(raw.slice(firstObj, lastObj + 1));
	}

	throw new Error('Could not parse AI preflight JSON output.');
}

function normalizeConcerns(payload: unknown): PreflightConcern[] {
	const obj = payload as { concerns?: unknown };
	if (!obj || typeof obj !== 'object' || !Array.isArray(obj.concerns)) return [];

	const concerns: PreflightConcern[] = [];
	for (let i = 0; i < obj.concerns.length; i += 1) {
		const item = obj.concerns[i] as Record<string, unknown>;
		const message = String(item?.message ?? '').trim();
		if (!message) continue;
		const rawSeverity = String(item?.severity ?? 'question').toLowerCase();
		const severity: 'warning' | 'question' = rawSeverity === 'warning' ? 'warning' : 'question';
		const id = String(item?.id ?? `ai-concern-${i + 1}`)
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-_]/g, '-')
			.slice(0, 60);
		const hint = String(item?.hint ?? '').trim();

		concerns.push({
			id: id || `ai-concern-${i + 1}`,
			severity,
			message,
			...(hint ? { hint } : {}),
		});
	}

	const seen = new Set<string>();
	return concerns.filter((c) => {
		const key = `${c.severity}::${c.message.toLowerCase()}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function analyzeTicketWithAi(detail: JiraIssueDetail, hasContributing: boolean): Promise<PreflightConcern[] | null> {
	const prompt = buildAiPreflightPrompt(detail, hasContributing);
	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();

	try {
		if (preflightAgent === 'copilot') {
			const { stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 10 * 1024 * 1024 });
			return normalizeConcerns(extractJsonPayload(stdout)).slice(0, 6);
		}

		if (preflightAgent === 'cursor') {
			const { stdout } = await execFileAsync('cursor', ['agent', '-p', prompt], { maxBuffer: 10 * 1024 * 1024 });
			return normalizeConcerns(extractJsonPayload(stdout)).slice(0, 6);
		}
	} catch {
		// Ignore AI preflight failures; caller will decide whether to continue without concerns.
	}

	return null;
}

export async function runPreflightChecks(
	detail: JiraIssueDetail,
	hasContributing: boolean,
): Promise<PreflightResult> {
	const aiConcerns = await analyzeTicketWithAi(detail, hasContributing);
	const concerns = aiConcerns ?? [];
	const answers = new Map<string, string>();

	if (!concerns.length) {
		console.log(chalk.gray('\n  Preflight source: AI reviewer'));
		console.log(chalk.green('  ✓ No AI concerns found (or AI reviewer unavailable). Continuing.\n'));
		return { concerns, answers };
	}

	console.log(chalk.gray('  Preflight source: AI reviewer'));

	console.log(chalk.bold.yellow(`\n  ⚠ Preflight: ${concerns.length} concern(s) detected before starting work:\n`));

	for (let i = 0; i < concerns.length; i++) {
		const concern = concerns[i];
		const icon = concern.severity === 'warning' ? chalk.yellow('⚠') : chalk.cyan('?');
		console.log(`  ${icon} ${chalk.bold(`[${i + 1}/${concerns.length}]`)} ${concern.message}`);

		if (concern.hint) {
			console.log(chalk.gray(`    Hint: ${concern.hint}`));
		}

		const answer = await askLine(chalk.cyan('    Your input (press Enter to skip): '));

		if (concern.id === 'ticket-already-done' && answer.toLowerCase() === 'no') {
			throw new Error('User cancelled — ticket is already done.');
		}

		if (answer) {
			answers.set(concern.id, answer);
			console.log(chalk.green(`    ✓ Noted.\n`));
		} else {
			console.log(chalk.gray(`    ↳ Skipped.\n`));
		}
	}

	if (answers.size > 0) {
		console.log(chalk.green(`  ✓ Preflight complete — ${answers.size} clarification(s) will be included in the AI prompt.\n`));
	} else {
		console.log(chalk.green('  ✓ Preflight complete — proceeding with no additional context.\n'));
	}

	return { concerns, answers };
}

export function formatClarifications(result: PreflightResult): string {
	if (!result.answers.size) return '';

	const lines = ['--- USER CLARIFICATIONS (from preflight review) ---'];
	for (const [concernId, answer] of result.answers) {
		const concern = result.concerns.find((c) => c.id === concernId);
		const label = concern?.message ?? concernId;
		lines.push(`Q: ${label}`);
		lines.push(`A: ${answer}`);
		lines.push('');
	}
	lines.push('--- END CLARIFICATIONS ---');
	return lines.join('\n');
}
