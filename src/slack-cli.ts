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
import { getDescriptionText, getJiraBrowseUrl } from './jira-text.js';
import { resolveRepoPathsViaSlack } from './repo.js';
import { notifySlackStatus, postAndWaitForSelection } from './slack.js';
import type { SlackPickOption } from './slack.js';
import type { JiraIssueDetail, TicketRunStatus, TicketView, WorkAgentOption } from './types.js';
import { renderMultiTicketDashboard, renderMultiTicketSummary } from './ui.js';

const INTERACTIVE_AGENT_IDS = new Set(['copilot-interactive', 'claude-code-interactive']);

export async function slackPickScope(): Promise<TicketScope> {
	console.log(chalk.gray('Asking for scope selection via Slack...'));
	const options: SlackPickOption[] = [
		{ id: 'current-sprint', label: 'Current Sprint — active sprint tickets assigned to you' },
		{ id: 'all-assigned', label: 'All Assigned — all unresolved tickets across sprints' },
	];

	const [selected] = await postAndWaitForSelection('Choose ticket scope:', options);
	const label = options.find((o) => o.id === selected)?.label ?? selected;
	console.log(chalk.cyan(`Scope: ${label} (via Slack)`));
	return selected as TicketScope;
}

async function slackPickTickets(tickets: TicketView[]): Promise<TicketView[]> {
	if (!tickets.length) {
		console.log(chalk.yellow('No tickets found.'));
		await notifySlackStatus('No tickets found.');
		return [];
	}

	console.log(chalk.gray(`Posting ${tickets.length} ticket(s) to Slack for selection...`));
	const options: SlackPickOption[] = tickets.map((t) => ({
		id: t.key,
		label: `${t.key} — ${t.title} (${t.status})`,
	}));

	const selectedIds = await postAndWaitForSelection(
		'Select ticket(s) to work on:',
		options,
		true,
	);

	console.log(chalk.cyan(`Selected tickets: ${selectedIds.join(', ')} (via Slack)`));
	return tickets.filter((t) => selectedIds.includes(t.key));
}

async function slackPickAgent(): Promise<WorkAgentOption | null> {
	console.log(chalk.gray('Asking for agent selection via Slack...'));
	const allOptions = await getAvailableAgentOptions();
	const autonomousOptions = allOptions.filter((o) => !INTERACTIVE_AGENT_IDS.has(o.id));

	if (!autonomousOptions.length) {
		console.log(chalk.yellow('No autonomous AI agent CLIs found in PATH.'));
		await notifySlackStatus('No autonomous AI agent CLIs found in PATH.');
		return null;
	}

	const options: SlackPickOption[] = autonomousOptions.map((o) => ({
		id: o.id,
		label: `${o.label} — ${o.description}`,
	}));

	const [selectedId] = await postAndWaitForSelection('Choose AI agent:', options);
	const selected = autonomousOptions.find((o) => o.id === selectedId) ?? null;
	if (selected) console.log(chalk.cyan(`Agent: ${selected.label} (via Slack)`));
	return selected;
}

async function pushAndCreateMRs(
	ticketKey: string,
	title: string,
	repoPaths: Map<string, string>,
	jiraUrl: string,
): Promise<void> {
	console.log(chalk.gray(`Pushing branch & creating MR/PR for ${ticketKey}...`));
	await notifySlackStatus(`Pushing branch & creating MR/PR for ${ticketKey}...`);
	const mrUrls: string[] = [];
	for (const repoPath of repoPaths.values()) {
		try {
			const url = await pushBranchAndCreateMR(repoPath, ticketKey, title, jiraUrl);
			if (url) {
				mrUrls.push(url);
				console.log(chalk.green(`  MR/PR: ${url}`));
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.log(chalk.red(`  Push/MR failed for ${ticketKey}: ${msg}`));
			await notifySlackStatus(`Push/MR failed for ${ticketKey}: ${msg}`);
		}
	}
	if (mrUrls.length) {
		await notifySlackStatus(`MR/PR created for ${ticketKey}:\n${mrUrls.map((u) => `• ${u}`).join('\n')}`);
	}
}

async function slackPostAgentActions(
	ticketKey: string,
	title: string,
	repoPaths: Map<string, string>,
	jiraUrl: string,
): Promise<void> {
	const autoPush = (process.env.FORGEPILOT_AUTO_PUSH ?? '').trim().toLowerCase() === 'true';

	if (autoPush) {
		console.log(chalk.gray(`Auto-pushing branch and creating MR/PR (FORGEPILOT_AUTO_PUSH=true)...`));
		await pushAndCreateMRs(ticketKey, title, repoPaths, jiraUrl);
		return;
	}

	console.log(chalk.gray('Asking for post-agent action via Slack...'));
	const options: SlackPickOption[] = [
		{ id: 'push', label: 'Push branch & create MR/PR' },
		{ id: 'done', label: 'Done — go back to ticket selection' },
	];

	const [action] = await postAndWaitForSelection(
		`Agent finished for *${ticketKey}*. Choose next action:`,
		options,
	);
	console.log(chalk.cyan(`Action: ${action === 'push' ? 'Push branch & create MR/PR' : 'Done'} (via Slack)`));

	if (action === 'push') {
		await pushAndCreateMRs(ticketKey, title, repoPaths, jiraUrl);
	}
}

async function pushAllMultiTicket(successStatuses: TicketRunStatus[]): Promise<void> {
	for (const s of successStatuses) {
		for (const repoPath of s.repos) {
			try {
				console.log(chalk.gray(`  Pushing ${s.ticketKey} from ${repoPath}...`));
				const url = await pushBranchAndCreateMR(repoPath, s.ticketKey, s.title, '');
				if (url) {
					console.log(chalk.green(`  MR/PR: ${url}`));
					await notifySlackStatus(`${s.ticketKey}: ${url}`);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.log(chalk.red(`  ${s.ticketKey} push failed: ${msg}`));
				await notifySlackStatus(`${s.ticketKey} push failed: ${msg}`);
			}
		}
	}
}

async function slackMultiTicketPostActions(statuses: TicketRunStatus[]): Promise<void> {
	const successStatuses = statuses.filter((s) => s.status === 'done');
	const failedStatuses = statuses.filter((s) => s.status === 'failed');

	console.log(chalk.bold(`\nMulti-ticket summary: ${successStatuses.length} succeeded, ${failedStatuses.length} failed`));

	const summary = [
		`:robot_face: *ForgePilot — Multi-Ticket Summary*`,
		'',
		...successStatuses.map((s) => `:white_check_mark: ${s.ticketKey} — ${s.title}`),
		...failedStatuses.map((s) => `:x: ${s.ticketKey} — ${s.title} (${s.error ?? 'unknown error'})`),
	].join('\n');

	await notifySlackStatus(summary);

	if (!successStatuses.length) return;

	const autoPush = (process.env.FORGEPILOT_AUTO_PUSH ?? '').trim().toLowerCase() === 'true';

	if (autoPush) {
		console.log(chalk.gray('Auto-pushing all branches and creating MR/PRs (FORGEPILOT_AUTO_PUSH=true)...'));
		await pushAllMultiTicket(successStatuses);
		return;
	}

	console.log(chalk.gray('Asking for post-agent action via Slack...'));
	const options: SlackPickOption[] = [
		{ id: 'push-all', label: 'Push all branches & create MR/PRs' },
		{ id: 'cleanup', label: 'Clean up worktrees' },
		{ id: 'done', label: 'Done' },
	];

	const [action] = await postAndWaitForSelection('Choose next action:', options);
	const actionLabel = options.find((o) => o.id === action)?.label ?? action;
	console.log(chalk.cyan(`Action: ${actionLabel} (via Slack)`));

	if (action === 'push-all') {
		await pushAllMultiTicket(successStatuses);
	} else if (action === 'cleanup') {
		console.log(chalk.gray('Cleaning up worktrees...'));
		await cleanupWorktrees(statuses);
		await notifySlackStatus('Worktrees cleaned up.');
		console.log(chalk.green('Worktrees cleaned up.'));
	}
}

function formatTicketDetailForSlack(detail: JiraIssueDetail): string {
	const summary = String(detail.fields.summary ?? detail.key);
	const descText = getDescriptionText(detail);
	const desc = descText.length > 500 ? `${descText.slice(0, 497)}...` : descText;

	const acField = process.env.FORGEPILOT_JIRA_AC_FIELD?.trim();
	let ac = '';
	if (acField) {
		const raw = detail.fields[acField];
		if (typeof raw === 'string') ac = raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
	}

	const lines = [
		`:page_facing_up: *${detail.key} — ${summary}*`,
		'',
		`*Description:*\n${desc || '_No description_'}`,
		...(ac ? ['', `*Acceptance Criteria:*\n${ac}`] : []),
	];
	return lines.join('\n');
}

export async function startSlackCli(tickets: TicketView[], _boards: Map<number, string>): Promise<void> {
	console.log(chalk.bold('\nSlack-driven workflow active.'));
	await notifySlackStatus(':robot_face: *ForgePilot is ready.* Waiting for your selections via Slack...');

	const selectedTickets = await slackPickTickets(tickets);
	if (!selectedTickets.length) return;

	let agentOption: WorkAgentOption | null = null;
	const defaultAgentId = process.env.FORGEPILOT_DEFAULT_AGENT?.trim();
	if (defaultAgentId) {
		agentOption = resolveAgentOptionById(defaultAgentId) ?? null;
		if (agentOption) {
			console.log(chalk.cyan(`Agent: ${agentOption.label} (default, skipped Slack prompt)`));
			await notifySlackStatus(`Using default agent: *${agentOption.label}*`);
		}
	}
	if (!agentOption) {
		agentOption = await slackPickAgent();
	}
	if (!agentOption) return;

	const skipDetail = (process.env.FORGEPILOT_SKIP_DETAIL ?? '').trim().toLowerCase() === 'true';

	if (selectedTickets.length === 1) {
		const ticket = selectedTickets[0];
		console.log(chalk.gray(`Loading details for ${ticket.key}...`));
		await notifySlackStatus(`Loading details for ${ticket.key}...`);

		try {
			ticket.detail = await fetchIssueDetail(ticket.key);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.log(chalk.red(`Failed to load ${ticket.key}: ${msg}`));
			await notifySlackStatus(`Failed to load ${ticket.key}: ${msg}`);
			return;
		}

		if (!skipDetail) {
			console.log(chalk.gray(`Posting ticket details for ${ticket.key} to Slack...`));
			await notifySlackStatus(formatTicketDetailForSlack(ticket.detail));
		}

		console.log(chalk.gray(`Resolving repos for ${ticket.key}...`));
		const repoPaths = await resolveRepoPathsViaSlack(ticket.detail);
		if (!repoPaths.size) {
			console.log(chalk.yellow(`No repos resolved for ${ticket.key}.`));
			await notifySlackStatus(`No repos resolved for ${ticket.key}.`);
			return;
		}
		console.log(chalk.green(`Resolved ${repoPaths.size} repo(s) for ${ticket.key}`));

		console.log(chalk.bold(`\nStarting ${agentOption.label} for ${ticket.key}...`));
		await notifySlackStatus(`Starting ${agentOption.label} for ${ticket.key}...`);

		try {
			await launchAgentForRepos(ticket.detail, agentOption, repoPaths);
			console.log(chalk.green(`${agentOption.label} finished for ${ticket.key}.`));
			await notifySlackStatus(`:white_check_mark: ${agentOption.label} finished for ${ticket.key}.`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.log(chalk.red(`${agentOption.label} failed for ${ticket.key}: ${msg}`));
			await notifySlackStatus(`:x: ${agentOption.label} failed for ${ticket.key}: ${msg}`);
			return;
		}

		const jiraUrl = getJiraBrowseUrl(ticket.detail);
		const title = String(ticket.detail.fields.summary ?? ticket.title);
		await slackPostAgentActions(ticket.key, title, repoPaths, jiraUrl);
	} else {
		console.log(chalk.gray(`Loading details for ${selectedTickets.length} ticket(s)...`));
		await notifySlackStatus(`Loading details for ${selectedTickets.length} ticket(s)...`);

		const details = await Promise.all(
			selectedTickets.map(async (t) => {
				try {
					t.detail = await fetchIssueDetail(t.key);
					return t.detail;
				} catch {
					console.log(chalk.yellow(`  Failed to load ${t.key}`));
					return null;
				}
			}),
		);

		const validDetails = details.filter((d) => d !== null);
		if (!validDetails.length) {
			console.log(chalk.red('Could not load details for any selected ticket.'));
			await notifySlackStatus('Could not load details for any selected ticket.');
			return;
		}

		if (!skipDetail) {
			for (const d of validDetails) {
				console.log(chalk.gray(`Posting ticket details for ${d.key} to Slack...`));
				await notifySlackStatus(formatTicketDetailForSlack(d));
			}
		}

		console.log(chalk.bold(`\nStarting ${agentOption.label} for ${validDetails.length} ticket(s) in parallel...`));
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
