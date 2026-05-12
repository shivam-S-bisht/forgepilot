import https from 'node:https';

type JiraConfig = {
	baseUrl: string;
	email: string;
	apiToken: string;
	insecureTls: boolean;
};

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const getConfig = (): JiraConfig => {
	const baseUrl = process.env.FORGEPILOT_JIRA_BASE_URL?.trim().replace(/\/+$/, '');
	const email = process.env.FORGEPILOT_JIRA_EMAIL?.trim();
	const apiToken = process.env.FORGEPILOT_JIRA_API_TOKEN?.trim();
	const insecureTls = isTruthy(process.env.FORGEPILOT_JIRA_INSECURE_TLS);

	if (!baseUrl) throw new Error('FORGEPILOT_JIRA_BASE_URL is not set. Set it to your Jira instance URL (e.g. https://mycompany.atlassian.net).');
	if (!email) throw new Error('FORGEPILOT_JIRA_EMAIL is not set. Set it to your Atlassian account email.');
	if (!apiToken) throw new Error('FORGEPILOT_JIRA_API_TOKEN is not set. Generate one at https://id.atlassian.com/manage-profile/security/api-tokens');

	return { baseUrl, email, apiToken, insecureTls };
};

type InsecureRequestOptions = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
};

async function jiraFetchInsecureTls(options: InsecureRequestOptions): Promise<{ status: number; statusText: string; body: string }> {
	return new Promise((resolve, reject) => {
		const req = https.request(options.url, {
			method: options.method,
			headers: options.headers,
			rejectUnauthorized: false,
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			res.on('error', reject);
			res.on('end', () => {
				resolve({
					status: res.statusCode ?? 0,
					statusText: res.statusMessage ?? '',
					body: Buffer.concat(chunks).toString('utf8'),
				});
			});
		});

		req.on('error', reject);

		if (options.body) req.write(options.body);
		req.end();
	});
}

export async function jiraFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const { baseUrl, email, apiToken, insecureTls } = getConfig();
	const url = `${baseUrl}${path}`;
	const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
	const headers: Record<string, string> = {
		'Authorization': authHeader,
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		...(options?.headers as Record<string, string>),
	};
	const method = options?.method ?? 'GET';
	const body = typeof options?.body === 'string' ? options.body : undefined;

	if (insecureTls) {
		const response = await jiraFetchInsecureTls({ url, method, headers, body });

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Jira API ${response.status} ${response.statusText} for ${path}: ${response.body}`);
		}

		if (response.status === 204) return undefined as T;
		return JSON.parse(response.body) as T;
	}

	let response: Response;
	try {
		response = await fetch(url, {
			...options,
			headers,
		});
	} catch (error) {
		const err = error as Error & { cause?: { code?: string; message?: string } };
		const causeCode = err.cause?.code ?? '';
		const causeMessage = err.cause?.message ?? '';
		const tlsCodes = new Set([
			'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
			'SELF_SIGNED_CERT_IN_CHAIN',
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'CERT_HAS_EXPIRED',
			'ERR_TLS_CERT_ALTNAME_INVALID',
		]);

		if (tlsCodes.has(causeCode)) {
			const tlsHint = insecureTls
				? 'FORGEPILOT_JIRA_INSECURE_TLS is enabled, but TLS handshake still failed.'
				: 'Configure NODE_EXTRA_CA_CERTS with your corporate CA certificate, or set FORGEPILOT_JIRA_INSECURE_TLS=true as a temporary workaround for Jira calls only.';
			throw new Error(
				`Jira request failed for ${path}: TLS certificate validation failed (${causeCode}). ${tlsHint}`,
			);
		}

		const detail = [err.message, causeCode, causeMessage].filter(Boolean).join(' | ');
		throw new Error(`Jira request failed for ${path}: ${detail}`);
	}

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
