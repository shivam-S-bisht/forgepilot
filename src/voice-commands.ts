import type { TicketScope } from './jira.js';

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

function extractTicketKey(transcript: string): string | undefined {
	const match = transcript.toUpperCase().match(TICKET_KEY_PATTERN);
	if (!match) return undefined;
	return `${match[1]}-${match[2]}`;
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
		],
		handler: 'transitionTicket',
	},
	{
		id: 'search_tickets',
		phrases: ['search tickets', 'search jira', 'find tickets', 'query tickets'],
		description: 'Search Jira with a spoken query (converted to JQL)',
		handler: 'searchTickets',
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
