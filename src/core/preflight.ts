import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getCached, setCached } from './cache.js';
import { commentsText, getAcceptanceCriteria, getDescriptionText, linkedIssuesText } from '../tools/jira/jira-text.js';
import { extractRepoLabels, scanLocalRepos, getRemoteUrls } from './repo.js';
import { askConcernViaSlack, shouldUseSlackQa } from '../tools/slack/slack.js';
import type { JiraIssueDetail } from './types.js';
import { askUser } from './ask.js';
import { isVoiceModeActive, printAndSpeak } from '../tools/voice/voice-input.js';

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
	historyForPrompt: string;
};

type TicketHistoryEntry = {
	timestamp: string;
	contextHash: string;
	concerns: PreflightConcern[];
	answers: Array<{ concernId: string; answer: string }>;
};

type TicketHistoryRecord = {
	ticketKey: string;
	entries: TicketHistoryEntry[];
};

function normalizeForMatch(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function concernMatchKey(concern: PreflightConcern): string {
	return `${concern.severity}::${normalizeForMatch(concern.message)}`;
}

function buildPriorAnswerIndex(history: TicketHistoryRecord): Map<string, string> {
	const byConcernId = new Map<string, string>();
	const byMessageKey = new Map<string, string>();

	for (let i = history.entries.length - 1; i >= 0; i -= 1) {
		const entry = history.entries[i];
		for (const answer of entry.answers) {
			if (!answer.answer?.trim()) continue;
			const concern = entry.concerns.find((c) => c.id === answer.concernId);
			const messageKey = concern ? concernMatchKey(concern) : '';
			if (!byConcernId.has(answer.concernId)) {
				byConcernId.set(answer.concernId, answer.answer.trim());
			}
			if (messageKey && !byMessageKey.has(messageKey)) {
				byMessageKey.set(messageKey, answer.answer.trim());
			}
		}
	}

	const merged = new Map<string, string>();
	for (const [k, v] of byConcernId) merged.set(`id::${k}`, v);
	for (const [k, v] of byMessageKey) merged.set(`msg::${k}`, v);
	return merged;
}

function trimForPrompt(value: string, max = 5000): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n... (truncated)`;
}

function toTicketContext(detail: JiraIssueDetail): {
	title: string;
	status: string;
	description: string;
	ac: string;
	comments: string;
	links: string;
	repoUrls: string[];
} {
	const title = detail.fields.summary ?? '(no title)';
	const status = detail.fields.status?.name ?? 'Unknown';
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const comments = commentsText(detail);
	const links = linkedIssuesText(detail);
	const repoUrls = extractRepoLabels(description).map((x) => x.normalizedUrl);
	return { title, status, description, ac, comments, links, repoUrls };
}

function ticketContextHash(detail: JiraIssueDetail): string {
	const ctx = toTicketContext(detail);
	const raw = JSON.stringify({
		key: detail.key,
		title: ctx.title,
		status: ctx.status,
		description: ctx.description,
		ac: ctx.ac,
		comments: ctx.comments,
		links: ctx.links,
		repoUrls: ctx.repoUrls,
	});
	return createHash('sha256').update(raw).digest('hex');
}

function formatHistoryForPrompt(history: TicketHistoryRecord | null, maxEntries = 3): string {
	if (!history || history.entries.length === 0) return '';
	const recent = history.entries.slice(-maxEntries);
	const lines = ['Ticket history (previous preflight sessions):'];
	for (const entry of recent) {
		lines.push(`- ${entry.timestamp} | context=${entry.contextHash.slice(0, 12)}`);
		for (const ans of entry.answers) {
			const concern = entry.concerns.find((c) => c.id === ans.concernId);
			lines.push(`  Q: ${concern?.message ?? ans.concernId}`);
			lines.push(`  A: ${ans.answer}`);
		}
	}
	return lines.join('\n');
}

function buildAiPreflightPrompt(
	detail: JiraIssueDetail,
	hasContributing: boolean,
	historyForPrompt: string,
	localRepoStatus: string,
): string {
	const { title, status, description, ac, comments, links, repoUrls } = toTicketContext(detail);

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
		'- If status indicates done/closed/resolved but new work may still be requested, still raise a warning.',
		'- Do NOT raise concerns about repo access, cloning, or permissions if the repo is already available locally (see LocalRepoStatus below).',
		'',
		`Ticket Key: ${detail.key}`,
		`Title: ${title}`,
		`Status: ${status}`,
		`HasContributingOrAgents: ${hasContributing ? 'yes' : 'no'}`,
		`RepoUrlsInDescription: ${repoUrls.length ? repoUrls.join(', ') : '(none)'}`,
		`LocalRepoStatus: ${localRepoStatus || 'not checked'}`,
		'',
		`Description:\n${trimForPrompt(description, 6000)}`,
		'',
		`Acceptance Criteria:\n${trimForPrompt(ac, 4000)}`,
		'',
		`Linked Issues:\n${trimForPrompt(links, 3000)}`,
		'',
		`Comments:\n${trimForPrompt(comments, 6000)}`,
		'',
		historyForPrompt ? trimForPrompt(historyForPrompt, 4000) : 'Ticket history: (none)',
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

async function resolveLocalRepoStatus(detail: JiraIssueDetail): Promise<string> {
	try {
		const { repoUrls } = toTicketContext(detail);
		if (!repoUrls.length) return 'no repo URLs in ticket';

		const rootDir = (await getCached<string>('rootDir')) ?? process.env.FORGEPILOT_ROOT_DIR?.replace(/^~/, process.env.HOME ?? '~');
		if (!rootDir) return 'root directory not configured';

		const localPaths = await scanLocalRepos(rootDir);
		const remoteIndex = new Map<string, string>();
		for (const localPath of localPaths) {
			const remotes = await getRemoteUrls(localPath);
			for (const remote of remotes) {
				if (!remoteIndex.has(remote)) remoteIndex.set(remote, localPath);
			}
		}

		const results: string[] = [];
		for (const url of repoUrls) {
			const normalized = url.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
			let found = false;
			for (const [remote, localPath] of remoteIndex) {
				if (remote.toLowerCase().includes(normalized) || normalized.includes(remote.toLowerCase())) {
					results.push(`${url} → available locally at ${localPath}`);
					found = true;
					break;
				}
			}
			if (!found) results.push(`${url} → NOT found locally`);
		}
		return results.join('; ');
	} catch {
		return 'could not check';
	}
}

async function analyzeTicketWithAi(
	detail: JiraIssueDetail,
	hasContributing: boolean,
	historyForPrompt: string,
): Promise<PreflightConcern[] | null> {
	const localRepoStatus = await resolveLocalRepoStatus(detail);
	const prompt = buildAiPreflightPrompt(detail, hasContributing, historyForPrompt, localRepoStatus);
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

async function readTicketHistory(ticketKey: string): Promise<TicketHistoryRecord> {
	const cacheKey = `ticket-history-${ticketKey.toLowerCase()}`;
	const cached = await getCached<TicketHistoryRecord>(cacheKey);
	if (cached && Array.isArray(cached.entries)) {
		return cached;
	}
	return { ticketKey, entries: [] };
}

async function appendTicketHistory(
	ticketKey: string,
	entry: TicketHistoryEntry,
	maxEntries = 20,
): Promise<TicketHistoryRecord> {
	const history = await readTicketHistory(ticketKey);
	history.entries.push(entry);
	if (history.entries.length > maxEntries) {
		history.entries = history.entries.slice(-maxEntries);
	}
	await setCached(`ticket-history-${ticketKey.toLowerCase()}`, history);
	return history;
}

const QUESTION_STARTERS = /^\s*(what|how|why|which|can|should|is|does|do|will|would|could|where|when|who)\b/i;

function looksLikeQuestion(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (trimmed.endsWith('?')) return true;
	if (QUESTION_STARTERS.test(trimmed)) return true;
	return false;
}

async function clarifyWithAi(concern: PreflightConcern, userQuestion: string): Promise<string | null> {
	const preflightAgent = (process.env.FORGEPILOT_PREFLIGHT_AGENT ?? 'copilot').trim().toLowerCase();
	const prompt = [
		'The user is reviewing a preflight concern before starting work on a Jira ticket.',
		'They asked a follow-up question instead of providing an answer.',
		'Provide a concise, helpful clarification (2-3 sentences max). Do NOT return JSON.',
		'',
		`Original concern: ${concern.message}`,
		concern.hint ? `Hint: ${concern.hint}` : '',
		`User's question: ${userQuestion}`,
	].filter(Boolean).join('\n');

	try {
		if (preflightAgent === 'copilot') {
			const { stdout } = await execFileAsync('copilot', ['-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 });
			return stdout.trim() || null;
		}
		if (preflightAgent === 'cursor') {
			const { stdout } = await execFileAsync('cursor', ['agent', '-p', prompt], { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 });
			return stdout.trim() || null;
		}
	} catch {
		return null;
	}
	return null;
}

async function askConcern(
	concern: PreflightConcern,
	ticketKey: string,
	index: number,
	total: number,
): Promise<string> {
	if (shouldUseSlackQa()) {
		const answer = await askConcernViaSlack(concern, ticketKey, index, total);
		return answer ?? '';
	}

	const maxClarifications = 3;
	for (let round = 0; round < maxClarifications; round++) {
		const answer = await askUser(chalk.cyan('    Your input (press Enter to skip): '));
		if (!answer) return '';

		if (!looksLikeQuestion(answer)) return answer;

		console.log(chalk.gray('    Checking with AI for clarification...'));
		const clarification = await clarifyWithAi(concern, answer);
		if (clarification) {
			console.log(chalk.white(`    💡 ${clarification}`));
			if (isVoiceModeActive()) {
				printAndSpeak(clarification);
			}
		} else {
			console.log(chalk.gray('    Could not get clarification. Please provide your answer or press Enter to skip.'));
		}
	}

	return askUser(chalk.cyan('    Your input (press Enter to skip): '));
}

export async function runPreflightChecks(
	detail: JiraIssueDetail,
	hasContributing: boolean,
): Promise<PreflightResult> {
	const ticketHash = ticketContextHash(detail);
	const priorHistory = await readTicketHistory(detail.key);
	const historyForPrompt = formatHistoryForPrompt(priorHistory);
	const priorAnswerIndex = buildPriorAnswerIndex(priorHistory);
	const aiConcerns = await analyzeTicketWithAi(detail, hasContributing, historyForPrompt);
	const concerns = aiConcerns ?? [];
	const answers = new Map<string, string>();
	const concernsToAsk: PreflightConcern[] = [];
	let reusedAnswers = 0;

	if (!concerns.length) {
		console.log(chalk.gray('\n  Preflight source: AI reviewer'));
		console.log(chalk.green('  ✓ No AI concerns found (or AI reviewer unavailable). Continuing.\n'));
		await appendTicketHistory(detail.key, {
			timestamp: new Date().toISOString(),
			contextHash: ticketHash,
			concerns: [],
			answers: [],
		});
		return { concerns, answers, historyForPrompt };
	}

	console.log(chalk.gray('  Preflight source: AI reviewer'));
	if (shouldUseSlackQa()) {
		console.log(chalk.gray('  Q&A channel: Slack'));
	} else {
		console.log(chalk.gray('  Q&A channel: Terminal'));
	}

	console.log(chalk.bold.yellow(`\n  ⚠ Preflight: ${concerns.length} concern(s) detected before starting work:\n`));

	for (const concern of concerns) {
		const cachedAnswerByMessage = priorAnswerIndex.get(`msg::${concernMatchKey(concern)}`);
		const cachedAnswerById = priorAnswerIndex.get(`id::${concern.id}`);
		const cachedAnswer = cachedAnswerByMessage ?? cachedAnswerById;
		if (cachedAnswer) {
			answers.set(concern.id, cachedAnswer);
			reusedAnswers += 1;
			if (concern.id === 'ticket-already-done' && cachedAnswer.toLowerCase() === 'no') {
				throw new Error('User cancelled — ticket is already done (based on cached answer).');
			}
			continue;
		}
		concernsToAsk.push(concern);
	}

	if (reusedAnswers > 0) {
		console.log(chalk.gray(`  Reused ${reusedAnswers} prior answer(s) from cache for similar concerns.`));
	}

	if (isVoiceModeActive() && concernsToAsk.length > 0) {
		printAndSpeak(`${concernsToAsk.length} clarification${concernsToAsk.length === 1 ? '' : 's'} needed before starting work.`);
	}

	for (let i = 0; i < concernsToAsk.length; i++) {
		const concern = concernsToAsk[i];
		const icon = concern.severity === 'warning' ? chalk.yellow('⚠') : chalk.cyan('?');
		console.log(`  ${icon} ${chalk.bold(`[${i + 1}/${concernsToAsk.length}]`)} ${concern.message}`);

		if (concern.hint) {
			console.log(chalk.gray(`    Hint: ${concern.hint}`));
		}
		if (isVoiceModeActive()) {
			printAndSpeak(concern.message);
		}

		const answer = await askConcern(concern, detail.key, i + 1, concernsToAsk.length);

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

	if (!concernsToAsk.length) {
		console.log(chalk.green('  ✓ Preflight complete — all concerns matched cached history, no new questions asked.\n'));
	} else if (answers.size > 0) {
		console.log(
			chalk.green(
				`  ✓ Preflight complete — ${answers.size} clarification(s) will be included in the AI prompt.\n`,
			),
		);
	} else {
		console.log(chalk.green('  ✓ Preflight complete — proceeding with no additional context.\n'));
	}

	await appendTicketHistory(detail.key, {
		timestamp: new Date().toISOString(),
		contextHash: ticketHash,
		concerns,
		answers: [...answers.entries()].map(([concernId, answer]) => ({ concernId, answer })),
	});

	const updatedHistory = await readTicketHistory(detail.key);
	return { concerns, answers, historyForPrompt: formatHistoryForPrompt(updatedHistory) };
}

export function formatClarifications(result: PreflightResult): string {
	const lines: string[] = [];
	if (result.historyForPrompt) {
		lines.push('--- TICKET HISTORY CONTEXT ---', result.historyForPrompt, '--- END TICKET HISTORY CONTEXT ---', '');
	}
	if (!result.answers.size) {
		return lines.join('\n').trim();
	}
	lines.push('--- USER CLARIFICATIONS (from preflight review) ---');
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
