import type { TicketScope } from '../jira/jira.js';

export type VoiceCommandParam = {
	name: string;
	extract: (transcript: string) => string | undefined;
};

export type VoiceCommand = {
	id: string;
	phrases: string[];
	description: string;
	params?: VoiceCommandParam[];
	handler: string;
};

const TICKET_KEY_PATTERN = /\b([A-Z]{1,10})[- ]?(\d{1,6})\b/;
const TICKET_KEY_PATTERN_GLOBAL = /\b([A-Z]{1,10})[- ]?(\d{1,6})\b/g;

function extractTicketKey(transcript: string): string | undefined {
	const match = transcript.toUpperCase().match(TICKET_KEY_PATTERN);
	if (!match) return undefined;
	return `${match[1]}-${match[2]}`;
}

export function extractAllTicketKeys(transcript: string): string[] {
	const upper = transcript.toUpperCase();
	const keys: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = TICKET_KEY_PATTERN_GLOBAL.exec(upper)) !== null) {
		keys.push(`${m[1]}-${m[2]}`);
	}
	return [...new Set(keys)];
}

const ORDINAL_MAP: Record<string, number> = {
	first: 0, '1st': 0, one: 0,
	second: 1, '2nd': 1, two: 1,
	third: 2, '3rd': 2, three: 2,
	fourth: 3, '4th': 3, four: 3,
	fifth: 4, '5th': 4, five: 4,
	sixth: 5, '6th': 5, six: 5,
	seventh: 6, '7th': 6, seven: 6,
	eighth: 7, '8th': 7, eight: 7,
	ninth: 8, '9th': 8, nine: 8,
	tenth: 9, '10th': 9, ten: 9,
	last: -1,
};

export function extractOrdinalIndex(transcript: string): number | undefined {
	const lower = transcript.toLowerCase();
	for (const [word, idx] of Object.entries(ORDINAL_MAP)) {
		if (lower.includes(word)) return idx;
	}
	const numMatch = lower.match(/\bnumber\s+(\d+)/);
	if (numMatch) return parseInt(numMatch[1], 10) - 1;
	return undefined;
}

function extractOrdinalStr(transcript: string): string | undefined {
	const idx = extractOrdinalIndex(transcript);
	return idx !== undefined ? String(idx) : undefined;
}

function extractScope(transcript: string): TicketScope {
	const lower = transcript.toLowerCase();
	if (lower.includes('all') || lower.includes('assigned') || lower.includes('everything')) {
		return 'all-assigned';
	}
	return 'current-sprint';
}

export const VOICE_COMMANDS: VoiceCommand[] = [
	{
		id: 'list_tickets',
		phrases: [
			'fetch my tickets',
			'get my tickets',
			'show my tickets',
			'list tickets',
			'get sprint tickets',
			'show sprint',
			'what are my tickets',
			'fetch tickets',
			'show tickets',
			'get tickets',
		],
		description: 'Fetch Jira tickets from current sprint or all assigned',
		params: [
			{
				name: 'scope',
				extract: extractScope,
			},
		],
		handler: 'listTickets',
	},
	{
		id: 'get_ticket_details',
		phrases: [
			'show ticket',
			'get ticket',
			'ticket details',
			'describe ticket',
			'open ticket',
			'tell me about ticket',
			'what is ticket',
		],
		description: 'Get full details for a specific Jira ticket',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
		],
		handler: 'getTicketDetails',
	},
	{
		id: 'start_ticket',
		phrases: [
			'start working on',
			'work on ticket',
			'begin ticket',
			'start ticket',
			'pick up ticket',
			'take ticket',
			'start the work',
			'start work',
			'begin work',
			'lets work',
		],
		description: 'Start working on a ticket (prepare branch, build prompt, launch agent)',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
			{
				name: 'ticket_keys',
				extract: (transcript: string) => {
					const keys = extractAllTicketKeys(transcript);
					return keys.length > 1 ? keys.join(',') : undefined;
				},
			},
		],
		handler: 'startTicket',
	},
	{
		id: 'push_and_create_pr',
		phrases: [
			'push and create pr',
			'push and create mr',
			'create pull request',
			'create merge request',
			'push branch',
			'push changes',
			'raise pr',
			'raise mr',
			'open pr',
			'open mr',
		],
		description: 'Push the current branch and create a PR/MR',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
		],
		handler: 'pushAndCreatePR',
	},
	{
		id: 'check_status',
		phrases: [
			'check status',
			'branch status',
			'git status',
			'show status',
			'what changed',
			'show changes',
		],
		description: 'Show git branch status and uncommitted changes',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
		],
		handler: 'checkStatus',
	},
	{
		id: 'show_todo_progress',
		phrases: [
			'show progress',
			'todo progress',
			'check progress',
			'how far along',
			'show todos',
			'what is done',
			'what is left',
		],
		description: 'Show the todo checklist progress for a ticket',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
		],
		handler: 'showTodoProgress',
	},
	{
		id: 'check_review_comments',
		phrases: [
			'check review comments',
			'show review comments',
			'any review feedback',
			'review comments',
			'pr comments',
			'mr comments',
			'code review',
		],
		description: 'Fetch unresolved review comments for a ticket PR/MR',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
		],
		handler: 'checkReviewComments',
	},
	{
		id: 'transition_ticket',
		phrases: [
			'move ticket to in progress',
			'transition ticket',
			'start ticket',
			'mark in progress',
			'set in progress',
		],
		description: 'Transition a Jira ticket to In Progress',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
		],
		handler: 'transitionTicket',
	},
	{
		id: 'search_tickets',
		phrases: [
			'search tickets',
			'search jira',
			'find tickets',
			'query tickets',
			'tickets in',
			'show tickets in',
			'blocked tickets',
			'tickets in qa',
			'tickets in review',
			'tickets in progress',
			'tickets in backlog',
			'tickets about',
			'find blocked',
			'high priority tickets',
			'urgent tickets',
		],
		description: 'Search Jira with a spoken query (converted to JQL)',
		params: [
			{
				name: 'query',
				extract: (transcript: string) => transcript,
			},
		],
		handler: 'searchTickets',
	},
	{
		id: 'commit_changes',
		phrases: [
			'commit changes',
			'commit my changes',
			'git commit',
			'save changes',
			'commit work',
			'commit the code',
			'make a commit',
		],
		description: 'Stage and commit all changes with a spoken commit message',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
		],
		handler: 'commitChanges',
	},
	{
		id: 'prepare_branch',
		phrases: [
			'prepare branch',
			'create branch',
			'make a branch',
			'set up branch',
			'prepare repo',
			'checkout branch',
			'new branch',
		],
		description: 'Create and checkout a feature branch for a ticket',
		params: [
			{
				name: 'ticket_key',
				extract: extractTicketKey,
			},
			{
				name: 'ticket_index',
				extract: extractOrdinalStr,
			},
		],
		handler: 'prepareBranch',
	},
	{
		id: 'custom_task',
		phrases: [
			'work on something',
			'custom task',
			'start a task',
			'work on a task',
			'new task',
			'create a task',
			'start custom work',
			'work on this',
			'i want to work on',
			'lets build',
			'lets create',
			'lets implement',
			'build something',
			'implement something',
		],
		description: 'Provide a custom task description to work on (no Jira ticket needed)',
		handler: 'customTask',
	},
	{
		id: 'list_jobs',
		phrases: [
			'show jobs',
			'list jobs',
			'background jobs',
			'running agents',
			'show running agents',
			'what agents are running',
			'list background agents',
			'show background jobs',
			'agent status',
		],
		description: 'List all background agent jobs with their status',
		handler: 'listJobs',
	},
	{
		id: 'job_status',
		phrases: [
			'job status',
			'status of job',
			'is the agent done',
			'is the job done',
			'check job',
			'how is the agent doing',
			'agent progress',
			'is it finished',
			'is it done',
		],
		description: 'Check the status of a background agent job for a ticket',
		params: [
			{ name: 'ticket_key', extract: extractTicketKey },
			{ name: 'ticket_index', extract: extractOrdinalStr },
		],
		handler: 'jobStatus',
	},
	{
		id: 'view_job_logs',
		phrases: [
			'show logs',
			'view logs',
			'agent logs',
			'show agent output',
			'view agent output',
			'show job logs',
			'what did the agent do',
			'agent output',
			'tail logs',
		],
		description: 'View the last lines of a background agent log',
		params: [
			{ name: 'ticket_key', extract: extractTicketKey },
			{ name: 'ticket_index', extract: extractOrdinalStr },
		],
		handler: 'viewJobLogs',
	},
	{
		id: 'stop_job',
		phrases: [
			'stop agent',
			'stop job',
			'kill agent',
			'kill job',
			'cancel agent',
			'cancel job',
			'abort agent',
			'stop the agent',
			'stop background agent',
		],
		description: 'Stop a running background agent job',
		params: [
			{ name: 'ticket_key', extract: extractTicketKey },
			{ name: 'ticket_index', extract: extractOrdinalStr },
		],
		handler: 'stopJob',
	},
	{
		id: 'retry_job',
		phrases: [
			'retry job',
			'retry agent',
			'resume job',
			'resume agent',
			'restart agent',
			'restart job',
			'rerun agent',
			'try again',
			'relaunch agent',
		],
		description: 'Retry or resume a failed or stopped background agent job',
		params: [
			{ name: 'ticket_key', extract: extractTicketKey },
			{ name: 'ticket_index', extract: extractOrdinalStr },
		],
		handler: 'retryJob',
	},
	{
		id: 'show_more',
		phrases: [
			'show more',
			'next page',
			'more tickets',
			'show next',
			'next',
			'show the rest',
			'continue',
			'keep going',
		],
		description: 'Show the next page of tickets',
		handler: 'showMore',
	},
	{
		id: 'help',
		phrases: ['help', 'what can you do', 'list commands', 'show commands', 'available commands'],
		description: 'List all available voice commands',
		handler: 'showHelp',
	},
	{
		id: 'stop',
		phrases: ['stop listening', 'goodbye', 'exit', 'quit', 'stop'],
		description: 'Stop voice mode and exit',
		handler: 'stopVoice',
	},
];

export type MatchedCommand = {
	command: VoiceCommand;
	params: Record<string, string>;
	confidence: number;
};

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const STOP_WORDS = new Set([
	'the', 'a', 'an', 'my', 'me', 'i', 'to', 'for', 'of', 'on', 'in', 'is',
	'it', 'do', 'can', 'you', 'we', 'lets', 'let', 'please', 'just', 'now',
	'and', 'or', 'so', 'up', 'that', 'this', 'what', 'how', 'about',
]);

function contentWords(text: string): string[] {
	return text.split(' ').filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

function stemWord(word: string): string {
	return word
		.replace(/ing$/, '')
		.replace(/tion$/, '')
		.replace(/ed$/, '')
		.replace(/es$/, '')
		.replace(/s$/, '');
}

function scorePhraseMatch(phrase: string, transcript: string): number {
	if (transcript.includes(phrase)) {
		return Math.min(phrase.length / transcript.length + 0.5, 1);
	}

	const phraseWords = phrase.split(' ');
	const transcriptWords = new Set(transcript.split(' '));
	const transcriptStems = new Set([...transcriptWords].map(stemWord));

	let exactHits = 0;
	let stemHits = 0;
	for (const pw of phraseWords) {
		if (transcriptWords.has(pw)) {
			exactHits++;
		} else if (transcriptStems.has(stemWord(pw))) {
			stemHits++;
		}
	}
	const phraseScore = (exactHits + stemHits * 0.8) / phraseWords.length;

	const phraseCW = contentWords(phrase);
	const transcriptCW = contentWords(transcript);
	if (phraseCW.length === 0 || transcriptCW.length === 0) return phraseScore;

	const phraseStems = new Set(phraseCW.map(stemWord));
	let contentHits = 0;
	for (const tw of transcriptCW) {
		if (phraseStems.has(stemWord(tw))) contentHits++;
	}
	const contentScore = contentHits / Math.max(phraseCW.length, transcriptCW.length);

	return Math.max(phraseScore, contentScore);
}

export function matchCommand(transcript: string): MatchedCommand | null {
	const normalized = normalizeText(transcript);
	if (!normalized) return null;

	let bestMatch: MatchedCommand | null = null;
	let bestScore = 0;

	for (const command of VOICE_COMMANDS) {
		for (const phrase of command.phrases) {
			const score = scorePhraseMatch(normalizeText(phrase), normalized);
			if (score > bestScore) {
				bestScore = score;
				bestMatch = { command, params: {}, confidence: Math.min(score, 1) };
			}
		}
	}

	if (bestMatch && bestScore < 0.4) return null;

	if (bestMatch && bestMatch.command.params) {
		for (const param of bestMatch.command.params) {
			const value = param.extract(transcript);
			if (value) {
				bestMatch.params[param.name] = value;
			}
		}
	}

	return bestMatch;
}
