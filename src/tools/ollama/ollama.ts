import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

const DEFAULT_API_BASE = 'http://127.0.0.1:11434';
const RECOMMENDED_MODEL = 'qwen2.5-coder:7b';

let ollamaServeChild: ChildProcess | null = null;

export type OllamaModel = {
	name: string;
	size: string;
	modified: string;
};

export function getOllamaApiBase(): string {
	return process.env.FORGEPILOT_OLLAMA_API_BASE?.trim() || DEFAULT_API_BASE;
}

export function getConfiguredModel(): string | undefined {
	return process.env.FORGEPILOT_OLLAMA_MODEL?.trim() || undefined;
}

export async function isOllamaInstalled(): Promise<boolean> {
	try {
		await execFileAsync('command', ['-v', 'ollama'], { shell: true });
		return true;
	} catch {
		return false;
	}
}

export async function isOllamaServing(): Promise<boolean> {
	const base = getOllamaApiBase();
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
		clearTimeout(timeout);
		return res.ok;
	} catch {
		return false;
	}
}

export async function ensureOllamaServing(): Promise<boolean> {
	if (await isOllamaServing()) return true;

	console.log(chalk.gray('  Starting ollama serve...'));
	try {
		ollamaServeChild = spawn('ollama', ['serve'], {
			detached: true,
			stdio: 'ignore',
		});
		ollamaServeChild.unref();

		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			if (await isOllamaServing()) {
				console.log(chalk.green('  ✓ ollama serve started'));
				return true;
			}
		}

		console.log(chalk.yellow('  ollama serve started but API not responding yet. Proceeding anyway.'));
		return true;
	} catch {
		console.log(chalk.red('  Failed to start ollama serve. Is ollama installed?'));
		return false;
	}
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
	const base = getOllamaApiBase();
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
		clearTimeout(timeout);

		if (!res.ok) return [];

		const data = (await res.json()) as { models?: Array<{ name: string; size: number; modified_at: string }> };
		if (!data.models?.length) return [];

		return data.models.map((m) => ({
			name: m.name,
			size: formatBytes(m.size),
			modified: new Date(m.modified_at).toLocaleDateString(),
		}));
	} catch {
		return [];
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function pullOllamaModel(modelName: string): Promise<boolean> {
	console.log(chalk.bold(`\n  Pulling ${modelName}...`));
	console.log(chalk.gray('  This may take a few minutes depending on model size.\n'));

	try {
		const child = spawn('ollama', ['pull', modelName], {
			stdio: 'inherit',
		});

		const exitCode = await new Promise<number>((resolve) => {
			child.on('close', (code) => resolve(code ?? 1));
			child.on('error', () => resolve(1));
		});

		if (exitCode === 0) {
			console.log(chalk.green(`\n  ✓ ${modelName} pulled successfully`));
			return true;
		}
		console.log(chalk.red(`\n  Failed to pull ${modelName} (exit code ${exitCode})`));
		return false;
	} catch {
		console.log(chalk.red(`  Failed to pull ${modelName}`));
		return false;
	}
}

export function getRecommendedModel(): string {
	return RECOMMENDED_MODEL;
}

export function stopOllamaServe(): void {
	if (ollamaServeChild) {
		try { ollamaServeChild.kill(); } catch { /* */ }
		ollamaServeChild = null;
	}
}
