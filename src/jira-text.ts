import { getJiraBaseUrl } from './jira-client.js';
import type { JiraIssueDetail, SprintInfo } from './types.js';

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

export function buildWorkPrompt(
	detail: JiraIssueDetail,
	contributing = '',
	clarifications = '',
	axonHint = '',
	figmaSection = '',
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

	sections.push(
		'=== WORKFLOW ===',
		'Follow these steps in order:',
		'',
		'1. UNDERSTAND — Read the full ticket context below before writing any code.',
		'   Identify what is being asked, the scope of changes, and the acceptance criteria.',
		'',
		'2. EXPLORE — Examine the existing codebase: file structure, naming conventions,',
		'   patterns, imports, and how similar features are implemented.',
		'',
		'3. PLAN — Decide which files to create or modify. Outline your approach.',
		'   If the task is complex, break it into smaller steps.',
		'',
		'4. IMPLEMENT — Write the code. Follow existing patterns and contribution guidelines.',
		'   Prefer editing existing files over creating new ones.',
		'',
		'5. VERIFY — Run linters, type checks, and tests if the repo has them.',
		'   Fix any errors you introduced. Ensure the build passes.',
		'',
		'6. REVIEW — Self-review your changes against the acceptance criteria.',
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
		'- Do NOT commit or push any changes. Leave all changes unstaged for manual review.',
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

	return sections.join('\n');
}
