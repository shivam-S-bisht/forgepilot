import { runAcliJson } from './acli.js';
import type { JiraBoard, JiraIssueDetail, JiraIssueSummary, TicketView } from './types.js';

const DEFAULT_TICKETS_JQL =
	'assignee = currentUser() AND issuetype NOT IN subTaskIssueTypes() AND resolution = Unresolved ORDER BY updated DESC';
export const LOAD_MORE_TICKETS_JQL =
	'assignee = currentUser() AND issuetype NOT IN subTaskIssueTypes() ORDER BY updated DESC';

export async function fetchBoards(): Promise<Map<number, string>> {
	const response = await runAcliJson<Array<{ values?: JiraBoard[] }> | { values?: JiraBoard[] }>([
		'jira',
		'board',
		'search',
		'--paginate',
		'--json',
	]);
	const boardMap = new Map<number, string>();

	const pages = Array.isArray(response) ? response : [response];
	for (const page of pages) {
		for (const board of page.values ?? []) {
			boardMap.set(board.id, board.name);
		}
	}

	return boardMap;
}

export async function fetchMyCurrentAndFutureSprintIssues(): Promise<TicketView[]> {
	return fetchTicketsByJql(DEFAULT_TICKETS_JQL);
}

export async function fetchTicketsByJql(jql: string): Promise<TicketView[]> {
	const issues = await runAcliJson<JiraIssueSummary[]>([
		'jira',
		'workitem',
		'search',
		'--jql',
		jql,
		'--fields',
		'key,summary,status',
		'--paginate',
		'--json',
	]);

	return issues.map((issue) => ({
		key: issue.key,
		title: issue.fields?.summary ?? '(no title)',
		status: issue.fields?.status?.name ?? 'Unknown',
	}));
}

export async function fetchIssueDetail(issueKey: string): Promise<JiraIssueDetail> {
	return runAcliJson<JiraIssueDetail>(['jira', 'workitem', 'view', issueKey, '--fields', '*all', '--json']);
}
