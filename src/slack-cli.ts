import chalk from 'chalk';
import {
	cleanupWorktrees,
	getAvailableAgentOptions,
	launchAgentForRepos,
	launchMultipleTickets,
	resolveAgentOptionById,
} from './agents.js';
import { pushBranchAndCreateMR } from './git.js';
import { fetchIssueDetail } from './jira.js';
import type { TicketScope } from './jira.js';
import { getJiraBrowseUrl } from './jira-text.js';
import { resolveRepoPathsViaSlack } from './repo.js';
import { notifySlackStatus, postAndWaitForSelection } from './slack.js';
import type { SlackPickOption } from './slack.js';
import type { TicketRunStatus, TicketView, WorkAgentOption } from './types.js';
import { renderMultiTicketDashboard, renderMultiTicketSummary } from './ui.js';

const INTERACTIVE_AGENT_IDS = new Set(['copilot-interactive', 'claude-code-interactive']);

export async function slackPickScope(): Promise<TicketScope> {
	const options: SlackPickOption[] = [
		{ id: 'current-sprint', label: 'Current Sprint — active sprint tickets assigned to you' },
		{ id: 'all-assigned', label: 'All Assigned — all unresolved tickets across sprints' },
	];

	const [selected] = await postAndWaitForSelection('Choose ticket scope:', options);
	return selected as TicketScope;
}

async function slackPickTickets(tickets: TicketView[]): Promise<TicketView[]> {
	if (!tickets.length) {
		await notifySlackStatus('No tickets found.');
		return [];
	}

	const options: SlackPickOption[] = tickets.map((t) => ({
		id: t.key,
		label: `${t.key} — ${t.title} (${t.status})`,
	}));

	const selectedIds = await postAndWaitForSelection(
		'Select ticket(s) to work on:',
		options,
		true,
	);

	return tickets.filter((t) => selectedIds.includes(t.key));
}

async function slackPickAgent(): Promise<WorkAgentOption | null> {
	const allOptions = await getAvailableAgentOptions();
	const autonomousOptions = allOptions.filter((o) => !INTERACTIVE_AGENT_IDS.has(o.id));

	if (!autonomousOptions.length) {
		await notifySlackStatus('No autonomous AI agent CLIs found in PATH.');
		return null;
	}

	const options: SlackPickOption[] = autonomousOptions.map((o) => ({
		id: o.id,
		label: `${o.label} — ${o.description}`,
	}));

	const [selectedId] = await postAndWaitForSelection('Choose AI agent:', options);
	return autonomousOptions.find((o) => o.id === selectedId) ?? null;
}

async function slackPostAgentActions(
	ticketKey: string,
	title: string,
	repoPaths: Map<string, string>,
	jiraUrl: string,
): Promise<void> {
	const options: SlackPickOption[] = [
		{ id: 'push', label: 'Push branch & create MR/PR' },
		{ id: 'done', label: 'Done — go back to ticket selection' },
	];

	const [action] = await postAndWaitForSelection(
		`Agent finished for *${ticketKey}*. Choose next action:`,
		options,
	);

	if (action === 'push') {
		await notifySlackStatus(`Pushing branch & creating MR/PR for ${ticketKey}...`);
		const mrUrls: string[] = [];
		for (const repoPath of repoPaths.values()) {
			try {
				const url = await pushBranchAndCreateMR(repoPath, ticketKey, title, jiraUrl);
				if (url) mrUrls.push(url);
			} catch (error) {
				await notifySlackStatus(`Push/MR failed for ${ticketKey}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (mrUrls.length) {
			await notifySlackStatus(`MR/PR created for ${ticketKey}:\n${mrUrls.map((u) => `• ${u}`).join('\n')}`);
		}
	}
}

async function slackMultiTicketPostActions(statuses: TicketRunStatus[]): Promise<void> {
	const successStatuses = statuses.filter((s) => s.status === 'done');
	const failedStatuses = statuses.filter((s) => s.status === 'failed');

	const summary = [
		`:robot_face: *ForgePilot — Multi-Ticket Summary*`,
		'',
		...successStatuses.map((s) => `:white_check_mark: ${s.ticketKey} — ${s.title}`),
		...failedStatuses.map((s) => `:x: ${s.ticketKey} — ${s.title} (${s.error ?? 'unknown error'})`),
	].join('\n');

	await notifySlackStatus(summary);

	if (!successStatuses.length) return;

	const options: SlackPickOption[] = [
		{ id: 'push-all', label: 'Push all branches & create MR/PRs' },
		{ id: 'cleanup', label: 'Clean up worktrees' },
		{ id: 'done', label: 'Done' },
	];

	const [action] = await postAndWaitForSelection('Choose next action:', options);

	if (action === 'push-all') {
		for (const s of successStatuses) {
			for (const repoPath of s.repos) {
				try {
					const url = await pushBranchAndCreateMR(repoPath, s.ticketKey, s.title, '');
					if (url) await notifySlackStatus(`${s.ticketKey}: ${url}`);
				} catch (error) {
					await notifySlackStatus(`${s.ticketKey} push failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	} else if (action === 'cleanup') {
		await cleanupWorktrees(statuses);
		await notifySlackStatus('Worktrees cleaned up.');
	}
}

export async function startSlackCli(tickets: TicketView[], _boards: Map<number, string>): Promise<void> {
	await notifySlackStatus(':robot_face: *ForgePilot is ready.* Waiting for your selections via Slack...');

	const selectedTickets = await slackPickTickets(tickets);
	if (!selectedTickets.length) return;

	let agentOption: WorkAgentOption | null = null;
	const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
	if (defaultAgentId) {
		agentOption = resolveAgentOptionById(defaultAgentId) ?? null;
		if (agentOption) {
			await notifySlackStatus(`Using default agent: *${agentOption.label}*`);
		}
	}
	if (!agentOption) {
		agentOption = await slackPickAgent();
	}
	if (!agentOption) return;

	if (selectedTickets.length === 1) {
		const ticket = selectedTickets[0];
		await notifySlackStatus(`Loading details for ${ticket.key}...`);

		try {
			ticket.detail = await fetchIssueDetail(ticket.key);
		} catch (error) {
			await notifySlackStatus(`Failed to load ${ticket.key}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const repoPaths = await resolveRepoPathsViaSlack(ticket.detail);
		if (!repoPaths.size) {
			await notifySlackStatus(`No repos resolved for ${ticket.key}.`);
			return;
		}

		await notifySlackStatus(`Starting ${agentOption.label} for ${ticket.key}...`);

		try {
			await launchAgentForRepos(ticket.detail, agentOption, repoPaths);
			await notifySlackStatus(`:white_check_mark: ${agentOption.label} finished for ${ticket.key}.`);
		} catch (error) {
			await notifySlackStatus(`:x: ${agentOption.label} failed for ${ticket.key}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const jiraUrl = getJiraBrowseUrl(ticket.detail);
		const title = String(ticket.detail.fields.summary ?? ticket.title);
		await slackPostAgentActions(ticket.key, title, repoPaths, jiraUrl);
	} else {
		await notifySlackStatus(`Loading details for ${selectedTickets.length} ticket(s)...`);

		const details = await Promise.all(
			selectedTickets.map(async (t) => {
				try {
					t.detail = await fetchIssueDetail(t.key);
					return t.detail;
				} catch {
					return null;
				}
			}),
		);

		const validDetails = details.filter((d) => d !== null);
		if (!validDetails.length) {
			await notifySlackStatus('Could not load details for any selected ticket.');
			return;
		}

		await notifySlackStatus(`Starting ${agentOption.label} for ${validDetails.length} ticket(s) in parallel...`);

		const statuses = await launchMultipleTickets(
			validDetails,
			agentOption,
			(s) => renderMultiTicketDashboard(s),
		);

		renderMultiTicketSummary(statuses);
		await slackMultiTicketPostActions(statuses);
	}
}
