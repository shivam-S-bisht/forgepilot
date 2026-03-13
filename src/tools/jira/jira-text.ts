import { getJiraBaseUrl } from './jira-client.js';
import type { JiraIssueDetail, SprintInfo } from '../../core/types.js';

const DEFAULT_AC_FIELD_IDS = ['customfield_13223', 'customfield_10039'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adfToText(node: any): string {
	if (!node) return '';
	if (typeof node === 'string') return node;
	if (Array.isArray(node)) return node.map((item) => adfToText(item)).join('');

	switch (node.type) {
		case 'text':
			return node.text ?? '';
		case 'hardBreak':
			return '\n';
		case 'inlineCard':
			return node.attrs?.url ?? '';
		case 'paragraph':
		case 'heading':
			return `${adfToText(node.content ?? [])}\n`;
		case 'bulletList':
			return (node.content ?? [])
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.map((item: any) => `- ${adfToText(item.content ?? []).trim()}`)
				.join('\n')
				.concat('\n');
		case 'orderedList': {
			const items = node.content ?? [];
			return items
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.map((item: any, index: number) => `${index + 1}. ${adfToText(item.content ?? []).trim()}`)
				.join('\n')
				.concat('\n');
		}
		case 'listItem':
			return adfToText(node.content ?? []);
		case 'doc':
			return adfToText(node.content ?? []);
		default:
			return adfToText(node.content ?? []);
	}
}

function extractAcceptanceCriteria(description: string): string {
	if (!description.trim()) return 'Not available';

	const regex =
		/(?:^|\n)(?:#+\s*)?(acceptance criteria|ac)\s*:?\s*\n([\s\S]*?)(?=\n(?:#+\s*)?[A-Za-z][A-Za-z0-9 _-]*\s*:?\s*\n|$)/i;
	const match = description.match(regex);
	if (!match?.[2]) return 'Not available';
	return match[2].trim();
}

export function getDescriptionText(detail: JiraIssueDetail): string {
	const descriptionText = adfToText(detail.fields.description).trim();
	return descriptionText || 'Not available';
}

export function getAcceptanceCriteria(detail: JiraIssueDetail): string {
	const configuredAcField = process.env.FORGEPILOT_JIRA_AC_FIELD?.trim();
	const candidateFields = configuredAcField ? [configuredAcField] : DEFAULT_AC_FIELD_IDS;

	for (const fieldKey of candidateFields) {
		const fieldValue = detail.fields[fieldKey];
		if (!fieldValue) continue;
		const acText = adfToText(fieldValue).trim();
		if (acText) return acText;
	}

	return extractAcceptanceCriteria(getDescriptionText(detail));
}

export function linkedIssuesText(detail: JiraIssueDetail): string {
	const links = detail.fields.issuelinks ?? [];
	if (!links.length) return 'None';

	return links
		.map((link) => {
			const target = link.outwardIssue ?? link.inwardIssue;
			if (!target?.key) return '';
			const relation = link.outwardIssue ? link.type?.outward : link.type?.inward;
			const summary = target.fields?.summary ?? '';
			const status = target.fields?.status?.name ?? 'Unknown';
			return `${target.key} (${status})${relation ? ` - ${relation}` : ''}${summary ? ` - ${summary}` : ''}`;
		})
		.filter(Boolean)
		.join('\n');
}

export function commentsText(detail: JiraIssueDetail): string {
	const comments = detail.fields.comment?.comments ?? [];
	if (!comments.length) return 'No comments';

	return comments
		.map((comment, index) => {
			const author = comment.author?.displayName ?? 'Unknown';
			const created = comment.created ?? '';
			const body = adfToText(comment.body).trim();
			return `${index + 1}. ${author}${created ? ` (${created})` : ''}\n${body || '(empty comment)'}`;
		})
		.join('\n\n');
}

export function extractSprintsFromFields(fields: Record<string, unknown>): SprintInfo[] {
	const sprints: SprintInfo[] = [];

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const maybeAddSprint = (value: any) => {
		if (!value || typeof value !== 'object') return;
		if (typeof value.id !== 'number' || typeof value.name !== 'string') return;

		if (
			value.state !== undefined ||
			value.startDate !== undefined ||
			value.endDate !== undefined ||
			value.boardId !== undefined
		) {
			sprints.push({
				id: value.id,
				name: value.name,
				state: typeof value.state === 'string' ? value.state : undefined,
				boardId: typeof value.boardId === 'number' ? value.boardId : undefined,
			});
		}
	};

	for (const value of Object.values(fields)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				maybeAddSprint(item);
			}
		} else {
			maybeAddSprint(value);
		}
	}

	const seen = new Set<number>();
	return sprints.filter((s) => {
		if (seen.has(s.id)) return false;
		seen.add(s.id);
		return true;
	});
}

export function boardSprintText(detail: JiraIssueDetail, boards: Map<number, string>): string {
	const sprints = extractSprintsFromFields(detail.fields);
	if (!sprints.length) return 'Not available';

	return sprints
		.map((sprint) => {
			const boardName = sprint.boardId
				? (boards.get(sprint.boardId) ?? `Board #${sprint.boardId}`)
				: 'Board unknown';
			const state = sprint.state ? ` (${sprint.state})` : '';
			return `${boardName} / ${sprint.name}${state}`;
		})
		.join('\n');
}

export function colorStatus(status: string): string {
	const normalized = status.toLowerCase();
	if (normalized.includes('progress')) return '\x1b[33m' + status + '\x1b[0m';
	if (normalized.includes('done') || normalized.includes('closed') || normalized.includes('resolved'))
		return '\x1b[32m' + status + '\x1b[0m';
	if (normalized.includes('open') || normalized.includes('to do') || normalized.includes('triage'))
		return '\x1b[36m' + status + '\x1b[0m';
	return status;
}

export function getJiraBrowseUrl(detail: JiraIssueDetail): string {
	if (detail.self) {
		try {
			const origin = new URL(detail.self).origin;
			return `${origin}/browse/${detail.key}`;
		} catch {
			// Ignore parse errors and use fallback.
		}
	}
	const base = getJiraBaseUrl();
	return base ? `${base}/browse/${detail.key}` : `https://clubautomation.atlassian.net/browse/${detail.key}`;
}

export type ReviewCommentForPrompt = {
	path: string;
	line: number | null;
	body: string;
	author: string;
};

export function buildWorkPrompt(
	detail: JiraIssueDetail,
	contributing = '',
	clarifications = '',
	axonHint = '',
	figmaSection = '',
	priorAnswers = '',
	resumeFromCheckpoint = false,
	reviewComments: ReviewCommentForPrompt[] = [],
	preApprovedPlan = false,
): string {
	const title = detail.fields.summary ?? '(no title)';
	const status = detail.fields.status?.name ?? 'Unknown';
	const description = getDescriptionText(detail);
	const ac = getAcceptanceCriteria(detail);
	const links = linkedIssuesText(detail);
	const comments = commentsText(detail);

	const sections: string[] = [];

	sections.push(
		'=== ROLE ===',
		'You are a senior software engineer implementing a Jira ticket.',
		'You write production-quality code that follows existing patterns in the codebase.',
		'You think before you code, explore the repo first, and verify your work.',
		'',
	);

	sections.push(
		'=== TASK ===',
		`Ticket: ${detail.key}`,
		`Title: ${title}`,
		`Status: ${status}`,
		'',
	);

	const todoFile = `.forgepilot-todos-${detail.key}.md`;
	const questionsFile = `.forgepilot-questions-${detail.key}.md`;
	const answersFile = `.forgepilot-answers-${detail.key}.md`;

	sections.push(
		'=== WORKFLOW ===',
		'Follow these steps in order:',
		'',
		'1. UNDERSTAND — Read the full ticket context below before writing any code.',
		'   Identify what is being asked, the scope of changes, and the acceptance criteria.',
		`   If ${answersFile} exists, read it first — it contains answers to your prior questions.`,
		'',
		'2. EXPLORE — Examine the existing codebase: file structure, naming conventions,',
		'   patterns, imports, and how similar features are implemented.',
		'',
		`3. PLAN — Create a file called ${todoFile} in the repo root with a markdown checklist`,
		`   of tasks derived from the ticket. Format:`,
		'',
		`   # ${detail.key}: ${title}`,
		'',
		'   - [ ] First task description',
		'   - [ ] Second task description',
		'   - [ ] ...',
		'',
		'   Break the work into small, logical units. Each item should be independently committable.',
		'',
		`4. ASK — If you have questions, ambiguities, or blockers that prevent you from continuing,`,
		`   write them to ${questionsFile} (one question per line, prefixed with "- ") and then STOP.`,
		'   Do NOT guess or make assumptions on critical decisions. Example:',
		'',
		`   - Should the video URL field accept YouTube links only or any URL?`,
		`   - Is there an existing validation utility I should reuse?`,
		'',
		'   ForgePilot will route your questions to the user and re-launch you with answers.',
		`   When re-launched with answers, review and update ${todoFile} — add, modify, or remove`,
		'   unchecked items based on the answers before continuing implementation.',
		`   If you have no questions, skip this step and continue.`,
		'',
		`5. IMPLEMENT — Work through each item in ${todoFile} one at a time:`,
		'   a. Complete the task.',
		`   b. Mark it done in ${todoFile} by changing "- [ ]" to "- [x]".`,
		`   c. Commit the code changes (do NOT include ${todoFile}, ${questionsFile}, or ${answersFile} in the commit).`,
		`      Use commit message format: ${detail.key} <concise description of what was done>`,
		'   d. Move to the next item.',
		'',
		'6. VERIFY — After all items are done, run linters, type checks, and tests if the repo has them.',
		'   Fix any errors you introduced. Ensure the build passes.',
		'',
		`7. CLEANUP — Delete ${todoFile}, ${questionsFile}, and ${answersFile} if they exist. Do NOT commit them.`,
		'',
		'8. REVIEW — Self-review your changes against the acceptance criteria.',
		'   Confirm every AC item is addressed. If something is unclear, add a TODO comment.',
		'',
	);

	sections.push(
		'=== TICKET CONTEXT ===',
		'',
		'--- Description ---',
		description || '(no description)',
		'',
		'--- Acceptance Criteria ---',
		ac || '(none specified)',
		'',
	);

	if (links && links !== '(none)') {
		sections.push('--- Linked Tickets ---', links, '');
	}

	if (comments && comments !== '(none)') {
		sections.push('--- Comments (most recent last) ---', comments, '');
	}

	sections.push(
		'=== CONSTRAINTS ===',
		`- Commit after completing each todo item. Use the format: ${detail.key} <concise description>. Do NOT include ${todoFile}, ${questionsFile}, or ${answersFile} in any commit. Do NOT push to remote.`,
		'- Do NOT add Co-authored-by, Signed-off-by, or any other trailers to commit messages. Keep commits clean with only the ticket key and description.',
		'- Do NOT delete or rename files unless the ticket explicitly requires it.',
		'- Match existing code style: indentation, naming, file organization, and patterns.',
		'- Prefer editing existing files over creating new ones.',
		'- If something is ambiguous, add a TODO comment explaining the uncertainty rather than guessing.',
		'- Handle errors gracefully — no silent failures, no empty catch blocks without reason.',
		'- If the repo has tests, add or update tests for your changes.',
		'- Do NOT add unnecessary comments that just narrate what the code does.',
		'',
	);

	if (contributing) {
		sections.push(
			'=== CONTRIBUTING GUIDELINES ===',
			'Follow these guidelines strictly. They take precedence over general best practices.',
			'',
			contributing,
			'',
			'=== END CONTRIBUTING GUIDELINES ===',
			'',
		);
	}

	if (figmaSection) {
		sections.push(figmaSection, '');
	}

	if (axonHint) {
		sections.push(axonHint, '');
	}

	if (clarifications) {
		sections.push(clarifications, '');
	}

	if (priorAnswers) {
		sections.push(
			'=== ANSWERS TO YOUR PRIOR QUESTIONS ===',
			'You previously asked questions and stopped. Here are the answers:',
			'',
			priorAnswers,
			'',
			'=== END ANSWERS ===',
			`Based on these answers, review your todo list in ${todoFile}:`,
			'- If an answer changes the scope or approach, UPDATE existing unchecked items accordingly.',
			'- If an answer reveals new work, ADD new unchecked items to the list.',
			'- If an answer makes an item unnecessary, REMOVE it or mark it as skipped with a note.',
			'- Do NOT modify already-checked items.',
			`Then continue implementing from the first unchecked item in ${todoFile}.`,
			'',
		);
	}

	if (reviewComments.length > 0) {
		const commentLines = reviewComments.map((c, i) => {
			const location = c.line ? `${c.path}:${c.line}` : c.path || 'general';
			return `${i + 1}. [${location}] @${c.author}: "${c.body}"`;
		});
		sections.push(
			'=== MR/PR REVIEW FEEDBACK ===',
			'Your previous work has been reviewed. Address the following unresolved review comments:',
			'',
			...commentLines,
			'',
			`Your todo file (${todoFile}) has been pre-populated with tasks derived from these comments.`,
			'Work through each item, commit after each fix, and ensure all review feedback is addressed.',
			`Do NOT recreate ${todoFile} — it already contains the review items.`,
			'Skip steps 1-3 of the WORKFLOW (UNDERSTAND, EXPLORE, PLAN) and go directly to step 5 (IMPLEMENT).',
			'=== END REVIEW FEEDBACK ===',
			'',
		);
	}

	if (preApprovedPlan) {
		sections.push(
			'=== PRE-APPROVED PLAN ===',
			`Your todo file (${todoFile}) has been pre-populated with a user-approved plan.`,
			'The user has reviewed and approved this plan before you started.',
			'Skip steps 1-3 of the WORKFLOW (UNDERSTAND, EXPLORE, PLAN) and go directly to step 5 (IMPLEMENT).',
			`Do NOT recreate or restructure ${todoFile} — the user has already approved it.`,
			'You may add sub-tasks within existing items if needed, but do not remove or reorder approved items.',
			'=== END PRE-APPROVED PLAN ===',
			'',
		);
	}

	if (resumeFromCheckpoint) {
		sections.push(
			'=== CHECKPOINT RESUME ===',
			'You were previously working on this ticket and were interrupted.',
			`Your todo file (${todoFile}) already exists with progress.`,
			'Items marked with [x] are already completed — do NOT redo them.',
			'Continue from the first unchecked item ([ ]). Do NOT recreate the todo file.',
			'Pick up exactly where you left off and follow the same WORKFLOW from step 5 (IMPLEMENT).',
			'',
		);
	}

	return sections.join('\n');
}

export function buildCustomTaskPrompt(
	taskDescription: string,
	branchName: string,
	contributing = '',
	axonHint = '',
): string {
	const todoFile = `.forgepilot-todos-${branchName.toUpperCase()}.md`;
	const sections: string[] = [];

	sections.push(
		'=== ROLE ===',
		'You are a senior software engineer implementing a custom task.',
		'You write production-quality code that follows existing patterns in the codebase.',
		'You think before you code, explore the repo first, and verify your work.',
		'',
	);

	sections.push(
		'=== TASK ===',
		taskDescription,
		'',
	);

	sections.push(
		'=== WORKFLOW ===',
		'',
		`1. UNDERSTAND — Read the task description carefully.`,
		'',
		'2. EXPLORE — Browse the codebase to understand the relevant areas.',
		'',
		`3. PLAN — Create ${todoFile} with a checklist of implementation tasks.`,
		'',
		`4. IMPLEMENT — Work through each item in ${todoFile} one at a time:`,
		'   a. Complete the task.',
		`   b. Mark it done in ${todoFile} by changing "- [ ]" to "- [x]".`,
		`   c. Commit the code changes (do NOT include ${todoFile} in the commit).`,
		`      Use commit message format: ${branchName} <concise description of what was done>`,
		'   d. Move to the next item.',
		'',
		'5. VERIFY — After all items are done, run linters, type checks, and tests if the repo has them.',
		'   Fix any errors you introduced. Ensure the build passes.',
		'',
		`6. CLEANUP — Delete ${todoFile} if it exists. Do NOT commit it.`,
		'',
	);

	sections.push(
		'=== CONSTRAINTS ===',
		`- Commit after completing each todo item. Use the format: ${branchName} <concise description>. Do NOT include ${todoFile} in any commit. Do NOT push to remote.`,
		'- Do NOT add Co-authored-by, Signed-off-by, or any other trailers to commit messages.',
		'- Do NOT delete or rename files unless the task explicitly requires it.',
		'- Match existing code style: indentation, naming, file organization, and patterns.',
		'- Prefer editing existing files over creating new ones.',
		'- Handle errors gracefully — no silent failures, no empty catch blocks without reason.',
		'- If the repo has tests, add or update tests for your changes.',
		'- Do NOT add unnecessary comments that just narrate what the code does.',
		'',
	);

	if (contributing) {
		sections.push(
			'=== CONTRIBUTING GUIDELINES ===',
			'Follow these guidelines strictly. They take precedence over general best practices.',
			'',
			contributing,
			'',
			'=== END CONTRIBUTING GUIDELINES ===',
			'',
		);
	}

	if (axonHint) {
		sections.push(axonHint, '');
	}

	return sections.join('\n');
}
