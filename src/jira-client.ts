const getConfig = () => {
	const baseUrl = process.env.FORGEPILOT_JIRA_BASE_URL?.trim().replace(/\/+$/, '');
	const email = process.env.FORGEPILOT_JIRA_EMAIL?.trim();
	const apiToken = process.env.FORGEPILOT_JIRA_API_TOKEN?.trim();

	if (!baseUrl) throw new Error('FORGEPILOT_JIRA_BASE_URL is not set. Set it to your Jira instance URL (e.g. https://mycompany.atlassian.net).');
	if (!email) throw new Error('FORGEPILOT_JIRA_EMAIL is not set. Set it to your Atlassian account email.');
	if (!apiToken) throw new Error('FORGEPILOT_JIRA_API_TOKEN is not set. Generate one at https://id.atlassian.com/manage-profile/security/api-tokens');

	return { baseUrl, email, apiToken };
};

export async function jiraFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const { baseUrl, email, apiToken } = getConfig();
	const url = `${baseUrl}${path}`;
	const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

	const response = await fetch(url, {
		...options,
		headers: {
			'Authorization': authHeader,
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			...(options?.headers as Record<string, string>),
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Jira API ${response.status} ${response.statusText} for ${path}: ${body}`);
	}

	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

export function getJiraBaseUrl(): string {
	return (process.env.FORGEPILOT_JIRA_BASE_URL?.trim().replace(/\/+$/, '') ?? '');
}
