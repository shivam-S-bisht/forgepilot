import chalk from 'chalk';
import type { PreflightConcern } from '../../core/preflight.js';

type SlackPostMessageResponse = {
	ok: boolean;
	error?: string;
	ts?: string;
};

type SlackRepliesResponse = {
	ok: boolean;
	error?: string;
	messages?: Array<{
		ts?: string;
		text?: string;
		user?: string;
		bot_id?: string;
		thread_ts?: string;
		subtype?: string;
	}>;
};

function getRequiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required env: ${name}`);
	return value;
}

function isSlackQaEnabled(): boolean {
	return (process.env.FORGEPILOT_SLACK_QA ?? 'false').trim().toLowerCase() === 'true';
}

function canPostToSlackChannel(): boolean {
	return !!process.env.FORGEPILOT_SLACK_BOT_TOKEN?.trim() && !!process.env.FORGEPILOT_SLACK_CHANNEL_ID?.trim();
}

async function slackApi<T>(endpoint: string, options: RequestInit): Promise<T> {
	const token = getRequiredEnv('FORGEPILOT_SLACK_BOT_TOKEN');
	const response = await fetch(`https://slack.com/api/${endpoint}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json; charset=utf-8',
			...(options.headers ?? {}),
		},
	});
	const payload = (await response.json()) as T;
	return payload;
}

async function postMessage(channel: string, text: string): Promise<string> {
	const payload = await slackApi<SlackPostMessageResponse>('chat.postMessage', {
		method: 'POST',
		body: JSON.stringify({ channel, text }),
	});
	if (!payload.ok || !payload.ts) {
		throw new Error(`Slack chat.postMessage failed: ${payload.error ?? 'unknown error'}`);
	}
	return payload.ts;
}

async function fetchThreadReplies(channel: string, threadTs: string): Promise<SlackRepliesResponse> {
	const token = getRequiredEnv('FORGEPILOT_SLACK_BOT_TOKEN');
	const url = new URL('https://slack.com/api/conversations.replies');
	url.searchParams.set('channel', channel);
	url.searchParams.set('ts', threadTs);
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});
	return (await response.json()) as SlackRepliesResponse;
}

function extractUserAnswer(
	replies: SlackRepliesResponse,
	questionTs: string,
	expectedUserId?: string,
): string | null {
	if (!replies.ok || !Array.isArray(replies.messages)) return null;

	for (const msg of replies.messages) {
		if (!msg.ts || msg.ts === questionTs) continue;
		if (!msg.text?.trim()) continue;
		if (msg.bot_id) continue;
		if (expectedUserId && msg.user !== expectedUserId) continue;
		return msg.text.trim();
	}
	return null;
}

async function postWebhookNotification(text: string): Promise<void> {
	const webhookUrl = process.env.FORGEPILOT_SLACK_WEBHOOK_URL?.trim();
	if (!webhookUrl) return;
	try {
		await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({ text }),
		});
	} catch {
		// Ignore notification failures.
	}
}

export async function notifySlackStatus(text: string): Promise<void> {
	if (!isSlackQaEnabled()) return;

	const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
	console.log(chalk.gray(`  [Slack] ${preview}`));

	try {
		if (canPostToSlackChannel()) {
			const channel = getRequiredEnv('FORGEPILOT_SLACK_CHANNEL_ID');
			await postMessage(channel, text);
		}
	} catch {
		// Fall back to webhook-only notification path below.
	}

	await postWebhookNotification(text);
}

export async function askConcernViaSlack(
	concern: PreflightConcern,
	ticketKey: string,
	index: number,
	total: number,
): Promise<string | null> {
	if (!isSlackQaEnabled()) return null;

	const channel = getRequiredEnv('FORGEPILOT_SLACK_CHANNEL_ID');
	const expectedUserId = process.env.FORGEPILOT_SLACK_EXPECTED_USER_ID?.trim();
	const pollIntervalMs = Number(process.env.FORGEPILOT_SLACK_POLL_INTERVAL_MS ?? '5000');
	const timeoutMs = Number(process.env.FORGEPILOT_SLACK_ANSWER_TIMEOUT_MS ?? `${10 * 60 * 1000}`);

	const lines = [
		':robot_face: *ForgePilot Preflight*',
		`*Question ${index}/${total}* for *${ticketKey}*`,
		'',
		`*Severity:* \`${concern.severity}\``,
		`*Concern:* ${concern.message}`,
		...(concern.hint ? ['', `*Hint:* ${concern.hint}`] : []),
		'',
		'---',
		'*Reply in this thread* with your answer.',
		'Reply `skip` to skip this question.',
		...(expectedUserId ? [`Only replies from <@${expectedUserId}> will be accepted.`] : []),
	];

	const questionText = lines.join('\n');
	const questionTs = await postMessage(channel, questionText);
	await postWebhookNotification(`Asked Slack preflight question ${index}/${total} for ${ticketKey}.`);

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const replies = await fetchThreadReplies(channel, questionTs);
		if (!replies.ok) {
			throw new Error(`Slack conversations.replies failed: ${replies.error ?? 'unknown error'}`);
		}
		const answer = extractUserAnswer(replies, questionTs, expectedUserId);
		if (answer) {
			const normalized = answer.trim().toLowerCase();
			if (normalized === 'skip') return '';
			return answer.trim();
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(`Timed out waiting for Slack response for concern "${concern.id}".`);
}

export async function askQuestionViaSlack(
	question: string,
	ticketKey: string,
	index: number,
	total: number,
): Promise<string | null> {
	if (!isSlackQaEnabled()) return null;

	const channel = getRequiredEnv('FORGEPILOT_SLACK_CHANNEL_ID');
	const expectedUserId = process.env.FORGEPILOT_SLACK_EXPECTED_USER_ID?.trim();
	const pollIntervalMs = Number(process.env.FORGEPILOT_SLACK_POLL_INTERVAL_MS ?? '5000');
	const timeoutMs = Number(process.env.FORGEPILOT_SLACK_ANSWER_TIMEOUT_MS ?? `${10 * 60 * 1000}`);

	const lines = [
		':robot_face: *ForgePilot — Agent Question*',
		`*Question ${index}/${total}* for *${ticketKey}*`,
		'',
		question,
		'',
		'---',
		'*Reply in this thread* with your answer.',
		'Reply `skip` to skip this question.',
		...(expectedUserId ? [`Only replies from <@${expectedUserId}> will be accepted.`] : []),
	];

	const questionText = lines.join('\n');
	const questionTs = await postMessage(channel, questionText);
	await postWebhookNotification(`Agent asked question ${index}/${total} for ${ticketKey}.`);

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const replies = await fetchThreadReplies(channel, questionTs);
		if (!replies.ok) {
			throw new Error(`Slack conversations.replies failed: ${replies.error ?? 'unknown error'}`);
		}
		const answer = extractUserAnswer(replies, questionTs, expectedUserId);
		if (answer) {
			const normalized = answer.trim().toLowerCase();
			if (normalized === 'skip') return '';
			return answer.trim();
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(`Timed out waiting for Slack response for agent question on ${ticketKey}.`);
}

export type SlackPickOption = { id: string; label: string };

export async function postAndWaitForSelection(
	prompt: string,
	options: SlackPickOption[],
	allowMultiple = false,
): Promise<string[]> {
	const channel = getRequiredEnv('FORGEPILOT_SLACK_CHANNEL_ID');
	const expectedUserId = process.env.FORGEPILOT_SLACK_EXPECTED_USER_ID?.trim();
	const pollIntervalMs = Number(process.env.FORGEPILOT_SLACK_POLL_INTERVAL_MS ?? '5000');
	const timeoutMs = Number(process.env.FORGEPILOT_SLACK_ANSWER_TIMEOUT_MS ?? `${10 * 60 * 1000}`);

	const numbered = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
	const hint = allowMultiple
		? 'Reply with number(s), comma-separated (e.g. `1,3,5`)'
		: 'Reply with a number';

	const lines = [
		`:robot_face: *ForgePilot*`,
		'',
		prompt,
		'',
		numbered,
		'',
		`---`,
		`*${hint}* in this thread.`,
		...(expectedUserId ? [`Only replies from <@${expectedUserId}> will be accepted.`] : []),
	];

	console.log(chalk.gray(`  Posted to Slack: "${prompt}"`));
	const messageTs = await postMessage(channel, lines.join('\n'));
	console.log(chalk.gray(`  Waiting for Slack reply...`));

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const replies = await fetchThreadReplies(channel, messageTs);
		if (!replies.ok) {
			throw new Error(`Slack conversations.replies failed: ${replies.error ?? 'unknown error'}`);
		}
		const answer = extractUserAnswer(replies, messageTs, expectedUserId);
		if (answer) {
			const nums = answer
				.split(/[,\s]+/)
				.map((s) => parseInt(s.trim(), 10))
				.filter((n) => !isNaN(n) && n >= 1 && n <= options.length);

			if (nums.length > 0) {
				const selected = allowMultiple ? nums : [nums[0]];
				const selectedLabels = selected.map((n) => options[n - 1].label).join(', ');
				console.log(chalk.cyan(`  Slack reply: ${selectedLabels}`));
				return selected.map((n) => options[n - 1].id);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error('Timed out waiting for Slack selection.');
}

export function shouldUseSlackQa(): boolean {
	return isSlackQaEnabled();
}

export function isSlackFullFlowEnabled(): boolean {
	return isSlackQaEnabled() && canPostToSlackChannel();
}
