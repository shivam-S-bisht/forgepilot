export type JiraBoard = {
	id: number;
	name: string;
};

export type JiraIssueSummary = {
	key: string;
	id?: string;
	fields?: {
		summary?: string;
		status?: { name?: string };
	};
};

export type JiraIssueDetail = {
	key: string;
	self?: string;
	fields: Record<string, unknown> & {
		summary?: string;
		status?: { name?: string };
		description?: unknown;
		comment?: { comments?: Array<{ body?: unknown; created?: string; author?: { displayName?: string } }> };
		issuelinks?: Array<{
			type?: { inward?: string; outward?: string };
			inwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
			outwardIssue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } };
		}>;
	};
};

export type SprintInfo = {
	id: number;
	name: string;
	state?: string;
	boardId?: number;
};

export type TicketView = {
	key: string;
	title: string;
	status: string;
	detail?: JiraIssueDetail;
};

export type WorkAgentOption = {
	id:
		| 'copilot-autonomous'
		| 'copilot-interactive'
		| 'rovo-autonomous'
		| 'cursor-autonomous'
		| 'claude-code-autonomous'
		| 'claude-code-interactive'
		| 'gemini-autonomous'
		| 'codex-autonomous'
		| 'codex-full-auto'
		| 'aider-autonomous'
		| 'opencode-autonomous'
		| 'cline-autonomous'
		| 'ollama-local';
	label: string;
	description: string;
};

export type RepoLabel = {
	label: string;
	normalizedUrl: string;
};

export type TicketRunStatus = {
	ticketKey: string;
	title: string;
	status: 'queued' | 'running' | 'done' | 'failed';
	agent: string;
	repos: string[];
	error?: string;
	worktreePaths?: string[];
};

export type TicketRepoResolution = {
	repoPaths: Map<string, string>;
	needsWorktree: Set<string>;
};
