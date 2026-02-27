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
		// Fallback to heuristic checks below.
	}

	return null;
}

export function analyzeTicket(detail: JiraIssueDetail, hasContributing: boolean): PreflightConcern[] {
	const concerns: PreflightConcern[] = [];
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const comments = commentsText(detail);
	const repoLabels = extractRepoLabels(description);

	if (description === 'Not available' || description.length < 30) {
		concerns.push({
			id: 'empty-description',
			severity: 'warning',
			message: 'The ticket description is missing or very short.',
			hint: 'What should the AI implement? Provide a brief summary of the expected work.',
		});
	}

	if (ac === 'Not available') {
		concerns.push({
			id: 'missing-ac',
			severity: 'warning',
			message: 'No acceptance criteria found on this ticket.',
			hint: 'What conditions must be met for this work to be considered done?',
		});
	}

	if (!repoLabels.length) {
		concerns.push({
			id: 'no-repo-urls',
			severity: 'question',
			message: 'No repository URLs found in the ticket description.',
			hint: 'Which repository should the AI work in? The user will be asked for a path manually.',
		});
	}

	if (!hasContributing) {
		concerns.push({
			id: 'no-contributing',
			severity: 'warning',
			message: 'No CONTRIBUTING.md or AGENTS.md found in the target repository.',
			hint: 'Are there any coding conventions, branch naming rules, or style guides the AI should follow?',
		});
	}

	if (description !== 'Not available' && ac !== 'Not available') {
		const descLower = description.toLowerCase();
		const acLower = ac.toLowerCase();

		const descMentionsApi = /\b(api|endpoint|rest|graphql)\b/.test(descLower);
		const acMentionsUi = /\b(ui|button|screen|page|modal|component|view)\b/.test(acLower);
		const acMentionsApi = /\b(api|endpoint|rest|graphql)\b/.test(acLower);
		const descMentionsUi = /\b(ui|button|screen|page|modal|component|view)\b/.test(descLower);

		if (descMentionsApi && acMentionsUi && !descMentionsUi && !acMentionsApi) {
			concerns.push({
				id: 'desc-ac-mismatch',
				severity: 'question',
				message:
					'The description talks about API/backend work, but the acceptance criteria mention UI/frontend work.',
				hint: 'Should the AI focus on backend, frontend, or both?',
			});
		}
		if (descMentionsUi && acMentionsApi && !descMentionsApi && !acMentionsUi) {
			concerns.push({
				id: 'desc-ac-mismatch',
				severity: 'question',
				message:
					'The description talks about UI/frontend work, but the acceptance criteria mention API/backend work.',
				hint: 'Should the AI focus on frontend, backend, or both?',
			});
		}
	}

	if (comments !== 'No comments') {
		const commentLines = comments.split('\n');
		const questionPattern = /\?\s*$/;
		const unansweredQuestions = commentLines.filter((line) => questionPattern.test(line.trim()));
		if (unansweredQuestions.length >= 2) {
			concerns.push({
				id: 'open-questions-in-comments',
				severity: 'question',
				message: `There are ${unansweredQuestions.length} question(s) in the ticket comments that may be unresolved.`,
				hint: 'Are these questions already resolved? Provide any context the AI should know.',
			});
		}
	}

	if (description !== 'Not available') {
		const vaguePatterns = [
			/\b(tbd|to be decided|to be determined)\b/i,
			/\b(todo|to-do|to do)\b/i,
			/\b(placeholder|tbc|to be confirmed)\b/i,
			/\bwip\b/i,
		];
		const hasVague = vaguePatterns.some((p) => p.test(description));
		if (hasVague) {
			concerns.push({
				id: 'vague-description',
				severity: 'question',
				message: 'The description contains placeholder text (TBD, TODO, WIP, etc.).',
				hint: 'Can you clarify the parts that are still undecided?',
			});
		}
	}

	const title = detail.fields.summary ?? '';
	const status = detail.fields.status?.name?.toLowerCase() ?? '';
	if (status.includes('done') || status.includes('closed') || status.includes('resolved')) {
		concerns.push({
			id: 'ticket-already-done',
			severity: 'warning',
			message: `This ticket is marked as "${detail.fields.status?.name}". Are you sure you want the AI to work on it?`,
			hint: 'Type "yes" to proceed or "no" to cancel.',
		});
	}

	if (title.length < 10 && description === 'Not available') {
		concerns.push({
			id: 'insufficient-context',
			severity: 'warning',
			message: 'Both the title and description are too brief for the AI to understand the task.',
			hint: 'Please describe what the AI should implement.',
		});
	}

	return concerns;
}

export async function runPreflightChecks(
	detail: JiraIssueDetail,
	hasContributing: boolean,
): Promise<PreflightResult> {
	const aiConcerns = await analyzeTicketWithAi(detail, hasContributing);
	const concerns = aiConcerns && aiConcerns.length > 0 ? aiConcerns : analyzeTicket(detail, hasContributing);
	const answers = new Map<string, string>();

	if (!concerns.length) {
		console.log(chalk.green('\n  ✓ Preflight checks passed — no concerns found.\n'));
		return { concerns, answers };
	}

	if (aiConcerns && aiConcerns.length > 0) {
		console.log(chalk.gray('  Preflight source: AI reviewer'));
	} else {
		console.log(chalk.gray('  Preflight source: fallback rules'));
	}

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
