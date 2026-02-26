#!/usr/bin/env node

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const MAX_GUIDELINE_CHARS = 12000;

const AGENT_OPTIONS = [
	{
		id: 'copilot-auto',
		label: 'Copilot (Autonomous)',
		command: 'copilot',
		buildArgs: (repoPath, prompt) => ['-p', prompt, '--autopilot', '--allow-all-tools', '--allow-all-paths', '--add-dir', repoPath],
	},
	{
		id: 'rovo-auto',
		label: 'Rovo (Autonomous)',
		command: 'acli',
		buildArgs: (_repoPath, prompt) => ['rovodev', 'run', '--yolo', prompt],
	},
	{
		id: 'cursor-auto',
		label: 'Cursor Agent (Autonomous)',
		command: 'cursor',
		buildArgs: (repoPath, prompt) => ['agent', '--yolo', '--workspace', repoPath, '-p', prompt],
	},
	{
		id: 'copilot-interactive',
		label: 'Copilot (Interactive)',
		command: 'copilot',
		buildArgs: (repoPath, prompt) => ['-i', prompt, '--add-dir', repoPath],
	},
];

function parseArgs(argv) {
	const parsed = {
		targetDir: '',
		task: '',
		agent: '',
		jiraDescription: '',
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if ((token === '--target-dir' || token === '--dir' || token === '--repo') && argv[i + 1]) {
			parsed.targetDir = path.resolve(argv[i + 1]);
			i += 1;
			continue;
		}
		if (token === '--task' && argv[i + 1]) {
			parsed.task = argv[i + 1];
			i += 1;
			continue;
		}
		if (token === '--agent' && argv[i + 1]) {
			parsed.agent = argv[i + 1];
			i += 1;
			continue;
		}
		if ((token === '--jira' || token === '--description') && argv[i + 1]) {
			parsed.jiraDescription = argv[i + 1];
			i += 1;
			continue;
		}
		if (token === '--help' || token === '-h') {
			printHelp();
			process.exit(0);
		}
	}

	return parsed;
}

function printHelp() {
	console.log(`
forgepilot - run coding agents with repo guidelines

Usage:
  forgepilot [--target-dir <path>] [--jira "<jira-description>"] [--task "<task>"] [--agent <agent-id>]

Options:
  --target-dir <path>  Parent directory containing local repos (defaults to current directory)
  --jira "<text>"      Jira ticket description containing repo URLs
  --task "<task>"      Task to execute; if omitted, prompts interactively
  --agent <id>         Agent id (copilot-auto, rovo-auto, cursor-auto, copilot-interactive)
  -h, --help         Show help

Examples:
  forgepilot --target-dir ~/dev --jira "Admin repo - https://github.com/acme/admin" --task "Add unread count endpoint"
  forgepilot --dir ~/dev --jira "Admin - git@github.com:acme/admin.git, RN - https://github.com/acme/mobile" --agent cursor-auto
`);
}

async function listGuidelineFiles(repoPath) {
	const files = [];
	const rootCandidates = ['CONTRIBUTING.md', 'AGENTS.md', 'RULES.md'];
	for (const filename of rootCandidates) {
		const full = path.join(repoPath, filename);
		if (existsSync(full)) files.push(full);
	}

	const cursorRulesDir = path.join(repoPath, '.cursor', 'rules');
	if (existsSync(cursorRulesDir)) {
		const nested = await walkFiles(cursorRulesDir);
		for (const filePath of nested) {
			const lower = filePath.toLowerCase();
			if (lower.endsWith('.md') || lower.endsWith('.mdc') || lower.endsWith('.txt')) {
				files.push(filePath);
			}
		}
	}

	return files;
}

async function walkFiles(rootDir) {
	const result = [];
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			result.push(...(await walkFiles(fullPath)));
		} else {
			result.push(fullPath);
		}
	}
	return result;
}

async function readGuidelines(repoPath) {
	const files = await listGuidelineFiles(repoPath);
	const blocks = [];

	for (const filePath of files) {
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const relative = path.relative(repoPath, filePath) || path.basename(filePath);
			const trimmed = content.length > MAX_GUIDELINE_CHARS ? `${content.slice(0, MAX_GUIDELINE_CHARS)}\n...[truncated]` : content;
			blocks.push({ relative, content: trimmed });
		} catch {
			// Skip unreadable guideline files.
		}
	}

	return blocks;
}

function buildPrompt({ repoPath, task, guidelines, jiraDescription, allRepos }) {
	const sections = [
		`You are working in repository: ${repoPath}`,
		'This ticket may include multiple repositories; only use the repositories listed below.',
		`Resolved repositories for this ticket: ${allRepos.join(', ')}`,
		'Read and follow the repository guidelines below before writing code.',
		'If there are conflicts between files, prioritize CONTRIBUTING.md then AGENTS.md.',
		'Before coding, check if task is already complete. If complete, do not modify code.',
		'After implementing, run relevant lint/typecheck/tests per repo scripts.',
		'',
		`Jira description: ${jiraDescription}`,
		'',
		`Task: ${task}`,
		'',
	];

	if (!guidelines.length) {
		sections.push('No guideline file found (CONTRIBUTING.md / AGENTS.md / .cursor/rules). Use existing code patterns in repo.');
	} else {
		sections.push('Guidelines:');
		for (const item of guidelines) {
			sections.push(`\n--- FILE: ${item.relative} ---\n${item.content}`);
		}
	}

	return sections.join('\n');
}

function askLine(prompt) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function clearScreen() {
	process.stdout.write('\x1Bc');
}

function selectAgentInteractive() {
	return new Promise((resolve) => {
		let index = 0;
		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);

		const render = () => {
			clearScreen();
			console.log('Select agent (↑/↓ + Enter, q to cancel):\n');
			for (let i = 0; i < AGENT_OPTIONS.length; i += 1) {
				const option = AGENT_OPTIONS[i];
				const prefix = i === index ? '>' : ' ';
				console.log(`${prefix} ${option.id} - ${option.label}`);
			}
		};

		const cleanup = () => {
			process.stdin.removeListener('keypress', onKey);
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		};

		const onKey = (_str, key) => {
			if (key.ctrl && key.name === 'c') {
				cleanup();
				process.exit(130);
			}
			if (key.name === 'q' || key.name === 'escape') {
				cleanup();
				resolve(null);
				return;
			}
			if (key.name === 'up') {
				index = index === 0 ? AGENT_OPTIONS.length - 1 : index - 1;
				render();
				return;
			}
			if (key.name === 'down') {
				index = index === AGENT_OPTIONS.length - 1 ? 0 : index + 1;
				render();
				return;
			}
			if (key.name === 'return' || key.name === 'enter') {
				const selected = AGENT_OPTIONS[index];
				cleanup();
				resolve(selected);
			}
		};

		process.stdin.on('keypress', onKey);
		render();
	});
}

async function runCommand(command, args, cwd) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', cwd });
		child.on('error', (error) => {
			if (error?.code === 'ENOENT') {
				reject(new Error(`${command} not found in PATH.`));
				return;
			}
			reject(error);
		});
		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} exited with code ${code ?? 'unknown'}.`));
		});
	});
}

async function runCommandCapture(command, args, cwd) {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk);
		});
		child.on('error', (error) => {
			if (error?.code === 'ENOENT') {
				reject(new Error(`${command} not found in PATH.`));
				return;
			}
			reject(error);
		});
		child.on('exit', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${stderr.trim()}`));
		});
	});
}

function normalizeRepoUrl(raw) {
	if (!raw) return '';
	let value = raw.trim().replace(/^\[|\]$/g, '').replace(/[),.;]+$/g, '');

	const sshMatch = value.match(/^git@([^:]+):(.+)$/);
	if (sshMatch) {
		value = `${sshMatch[1]}/${sshMatch[2]}`;
	} else {
		try {
			const parsed = new URL(value);
			value = `${parsed.hostname}${parsed.pathname}`;
		} catch {
			// Keep as-is if URL parsing fails.
		}
	}

	return value.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
}

function extractRepoUrls(description) {
	const matches = description.match(/(https?:\/\/[^\s\])]+|git@[^\s\])]+)/gi) || [];
	const unique = new Set();
	for (const match of matches) {
		const normalized = normalizeRepoUrl(match);
		if (normalized) unique.add(normalized);
	}
	return [...unique];
}

async function listLocalRepos(rootDir) {
	const repos = [];

	async function walk(current, depth) {
		if (depth > 3) return;
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === '.git' || entry.name === 'node_modules') continue;
			const fullPath = path.join(current, entry.name);
			const gitPath = path.join(fullPath, '.git');
			if (existsSync(gitPath)) {
				repos.push(fullPath);
				continue;
			}
			await walk(fullPath, depth + 1);
		}
	}

	await walk(rootDir, 0);
	return repos;
}

async function getRepoRemoteUrls(repoPath) {
	const { stdout } = await runCommandCapture('git', ['-C', repoPath, 'remote', '-v'], repoPath);
	const urls = new Set();
	const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		const pieces = line.split(/\s+/);
		if (pieces.length < 2) continue;
		const normalized = normalizeRepoUrl(pieces[1]);
		if (normalized) urls.add(normalized);
	}
	return [...urls];
}

async function resolveTicketRepos(targetDir, jiraDescription) {
	const requestedUrls = extractRepoUrls(jiraDescription);
	if (!requestedUrls.length) {
		throw new Error('No repository URLs found in Jira description.');
	}

	const repoPaths = await listLocalRepos(targetDir);
	if (!repoPaths.length) {
		throw new Error(`No local git repositories found under target directory: ${targetDir}`);
	}

	const remoteToRepo = new Map();
	for (const repoPath of repoPaths) {
		try {
			const remotes = await getRepoRemoteUrls(repoPath);
			for (const remote of remotes) {
				if (!remoteToRepo.has(remote)) remoteToRepo.set(remote, repoPath);
			}
		} catch {
			// Ignore directories where git remotes cannot be resolved.
		}
	}

	const resolvedRepos = [];
	const missing = [];
	for (const requested of requestedUrls) {
		const local = remoteToRepo.get(requested);
		if (local) {
			resolvedRepos.push(local);
		} else {
			missing.push(requested);
		}
	}

	if (missing.length) {
		throw new Error(`Could not find these Jira repos under ${targetDir}: ${missing.join(', ')}`);
	}

	return [...new Set(resolvedRepos)];
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	let targetDirInput = args.targetDir;
	if (!targetDirInput) {
		targetDirInput = await askLine('Target parent directory (contains local repos): ');
	}
	if (!targetDirInput) {
		throw new Error('Target directory is required.');
	}
	const targetDir = path.resolve(targetDirInput);

	if (!existsSync(targetDir)) {
		throw new Error(`Target directory does not exist: ${targetDir}`);
	}

	let jiraDescription = args.jiraDescription;
	if (!jiraDescription) {
		jiraDescription = await askLine('Paste Jira description (must include repo URLs): ');
	}
	if (!jiraDescription) {
		throw new Error('Jira description is required.');
	}

	const repoPaths = await resolveTicketRepos(targetDir, jiraDescription);
	const outside = repoPaths.filter((repoPath) => !path.resolve(repoPath).startsWith(targetDir));
	if (outside.length) {
		throw new Error(`Resolved repository path is outside target directory: ${outside.join(', ')}`);
	}

	let task = args.task;
	if (!task) {
		task = await askLine('Describe task: ');
	}
	if (!task) {
		throw new Error('Task is required.');
	}

	let selected = AGENT_OPTIONS.find((item) => item.id === args.agent);
	if (!selected) {
		selected = await selectAgentInteractive();
	}
	if (!selected) {
		console.log('No agent selected. Exiting.');
		return;
	}

	console.log(`\nResolved ${repoPaths.length} repository(ies) from Jira description.`);
	for (const repoPath of repoPaths) {
		console.log(`- ${repoPath}`);
	}

	for (const repoPath of repoPaths) {
		console.log(`\nScanning guideline files in ${repoPath} ...`);
		const guidelines = await readGuidelines(repoPath);
		console.log(`Found ${guidelines.length} guideline file(s).`);

		const prompt = buildPrompt({
			repoPath,
			task,
			guidelines,
			jiraDescription,
			allRepos: repoPaths,
		});
		const cmdArgs = selected.buildArgs(repoPath, prompt);

		console.log(`\nStarting ${selected.label} for ${repoPath} ...\n`);
		await runCommand(selected.command, cmdArgs, repoPath);
	}
}

main().catch((error) => {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
