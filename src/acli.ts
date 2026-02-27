import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function splitConcatenatedJsonDocuments(raw: string): string[] {
	const documents: string[] = [];
	const text = raw.trim();
	if (!text) return documents;

	let startIndex = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (startIndex === -1) {
			if (ch === '{' || ch === '[') {
				startIndex = i;
				depth = 1;
			}
			continue;
		}

		if (ch === '{' || ch === '[') {
			depth += 1;
		} else if (ch === '}' || ch === ']') {
			depth -= 1;
			if (depth === 0) {
				documents.push(text.slice(startIndex, i + 1));
				startIndex = -1;
			}
		}
	}

	return documents;
}

export async function runAcliJson<T>(args: string[]): Promise<T> {
	try {
		const { stdout } = await execFileAsync('acli', args, { maxBuffer: 20 * 1024 * 1024 });

		try {
			return JSON.parse(stdout) as T;
		} catch {
			const docs = splitConcatenatedJsonDocuments(stdout);
			if (!docs.length) {
				throw new Error('Could not parse JSON output from acli.');
			}
			if (docs.length === 1) {
				return JSON.parse(docs[0]) as T;
			}

			const parsed = docs.map((doc) => JSON.parse(doc));
			if (parsed.every((item) => Array.isArray(item))) {
				return parsed.flat() as T;
			}

			return parsed as T;
		}
	} catch (error: unknown) {
		if (error && typeof error === 'object' && 'stdout' in error) {
			const errObj = error as Record<string, unknown>;
			const maybeStdout = String(errObj.stdout ?? '');
			const maybeStderr = String(errObj.stderr ?? '');
			throw new Error(`acli failed for "${args.join(' ')}": ${maybeStderr || maybeStdout || 'unknown error'}`);
		}
		throw error;
	}
}
