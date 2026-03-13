import { jiraFetch } from './jira-client.js';
import type { JiraBoard, JiraIssueDetail, JiraIssueSummary, TicketView } from '../../core/types.js';

export type TicketScope = 'current-sprint' | 'all-assigned';

const CURRENT_SPRINT_JQL =
	'assignee = currentUser() AND sprint in openSprints() AND issuetype NOT IN subTaskIssueTypes() AND resolution = Unresolved ORDER BY updated DESC';
const ALL_ASSIGNED_JQL =
	'assignee = currentUser() AND issuetype NOT IN subTaskIssueTypes() AND resolution = Unresolved ORDER BY updated DESC';
export const LOAD_MORE_TICKETS_JQL =
	'assignee = currentUser() AND issuetype NOT IN subTaskIssueTypes() ORDER BY updated DESC';

type BoardSearchResponse = {
	maxResults: number;
	startAt: number;
	total?: number;
	isLast?: boolean;
	values: JiraBoard[];
};

type IssueSearchResponse = {
	maxResults: number;
	total: number;
	issues: JiraIssueSummary[];
	nextPageToken?: string;
};

type TransitionsResponse = {
	transitions: Array<{ id: string; name: string }>;
};

export async function fetchBoards(): Promise<Map<number, string>> {
	const boardMap = new Map<number, string>();
	let startAt = 0;
	const maxResults = 50;

	while (true) {
		const response = await jiraFetch<BoardSearchResponse>(
			`/rest/agile/1.0/board?startAt=${startAt}&maxResults=${maxResults}`,
		);

		for (const board of response.values ?? []) {
			boardMap.set(board.id, board.name);
		}

		if (response.isLast || !response.values?.length || (response.total !== undefined && startAt + response.values.length >= response.total)) {
			break;
		}
		startAt += response.values.length;
	}

	return boardMap;
}

export async function fetchTicketsByScope(scope: TicketScope): Promise<TicketView[]> {
	const jql = scope === 'current-sprint' ? CURRENT_SPRINT_JQL : ALL_ASSIGNED_JQL;
	return fetchTicketsByJql(jql);
}

export async function fetchTicketsByJql(jql: string): Promise<TicketView[]> {
	const allIssues: JiraIssueSummary[] = [];
	const maxResults = 50;
	let nextPageToken: string | undefined;

	while (true) {
		const params = new URLSearchParams({
			jql,
			fields: 'key,summary,status',
			maxResults: String(maxResults),
		});
		if (nextPageToken) params.set('nextPageToken', nextPageToken);

		const response = await jiraFetch<IssueSearchResponse>(
			`/rest/api/3/search/jql?${params.toString()}`,
		);

		allIssues.push(...(response.issues ?? []));

		if (!response.nextPageToken || !response.issues?.length) break;
		nextPageToken = response.nextPageToken;
	}

	return allIssues.map((issue) => ({
		key: issue.key,
		title: issue.fields?.summary ?? '(no title)',
		status: issue.fields?.status?.name ?? 'Unknown',
	}));
}

export async function fetchIssueDetail(issueKey: string): Promise<JiraIssueDetail> {
	return jiraFetch<JiraIssueDetail>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`);
}

export async function createJiraIssue(
	projectKey: string,
	summary: string,
	description: string,
): Promise<JiraIssueDetail> {
	const body = {
		fields: {
			project: { key: projectKey },
			summary,
			description: {
				type: 'doc',
				version: 1,
				content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
			},
			issuetype: { name: 'Task' },
		},
	};
	const created = await jiraFetch<{ key: string }>('/rest/api/3/issue', {
		method: 'POST',
		body: JSON.stringify(body),
	});
	return fetchIssueDetail(created.key);
}

export async function transitionIssueToInProgress(detail: JiraIssueDetail): Promise<void> {
	const currentStatus = detail.fields.status?.name;
	if (currentStatus && currentStatus.toLowerCase().includes('progress')) return;

	const { transitions } = await jiraFetch<TransitionsResponse>(
		`/rest/api/3/issue/${encodeURIComponent(detail.key)}/transitions`,
	);

	const inProgressTransition = transitions.find(
		(t) => t.name.toLowerCase().includes('progress'),
	);

	if (!inProgressTransition) return;

	await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(detail.key)}/transitions`, {
		method: 'POST',
		body: JSON.stringify({ transition: { id: inProgressTransition.id } }),
	});
}
