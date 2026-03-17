import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');
const JOBS_FILE = path.join(CACHE_DIR, 'jobs.json');
const LOGS_DIR = path.join(CACHE_DIR, 'logs');

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped';

export type JobRecord = {
	id: string;
	ticketKey: string;
	title: string;
	agent: string;
	agentOptionId?: string;
	pid: number;
	logFile: string;
	status: JobStatus;
	error?: string;
	startedAt: string;
	finishedAt?: string;
	repos: string[];
	effectivePaths: string[];
};

type JobStore = Record<string, JobRecord>;

let jobCache: JobStore | null = null;

async function ensureDirs(): Promise<void> {
	if (!existsSync(CACHE_DIR)) await fs.mkdir(CACHE_DIR, { recursive: true });
	if (!existsSync(LOGS_DIR)) await fs.mkdir(LOGS_DIR, { recursive: true });
}

async function loadStore(): Promise<JobStore> {
	if (jobCache) return jobCache;
	if (!existsSync(JOBS_FILE)) {
		jobCache = {};
		return jobCache;
	}
	try {
		const raw = await fs.readFile(JOBS_FILE, 'utf8');
		jobCache = JSON.parse(raw) as JobStore;
	} catch {
		jobCache = {};
	}
	return jobCache;
}

async function persistStore(): Promise<void> {
	await ensureDirs();
	await fs.writeFile(JOBS_FILE, JSON.stringify(jobCache ?? {}, null, 2), 'utf8');
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function registerJob(record: JobRecord): Promise<void> {
	const store = await loadStore();
	store[record.id] = record;
	await persistStore();
}

export async function updateJob(id: string, partial: Partial<JobRecord>): Promise<void> {
	const store = await loadStore();
	if (!store[id]) return;
	Object.assign(store[id], partial);
	await persistStore();
}

export async function getJobs(): Promise<JobRecord[]> {
	const store = await loadStore();
	return Object.values(store);
}

export async function getRunningJobs(): Promise<JobRecord[]> {
	const store = await loadStore();
	return Object.values(store).filter((j) => j.status === 'running');
}

export async function getJob(id: string): Promise<JobRecord | null> {
	const store = await loadStore();
	return store[id] ?? null;
}

export async function isTicketRunning(ticketKey: string): Promise<boolean> {
	const store = await loadStore();
	return Object.values(store).some(
		(j) => j.ticketKey === ticketKey && j.status === 'running',
	);
}

export async function stopJob(id: string): Promise<boolean> {
	const store = await loadStore();
	const job = store[id];
	if (!job || job.status !== 'running') return false;
	try {
		process.kill(job.pid, 'SIGTERM');
	} catch {
		// Process may already be dead
	}
	job.status = 'stopped';
	job.finishedAt = new Date().toISOString();
	await persistStore();
	return true;
}

export async function removeJob(id: string): Promise<void> {
	const store = await loadStore();
	delete store[id];
	await persistStore();
}

export async function cleanupStaleJobs(): Promise<number> {
	const store = await loadStore();
	let cleaned = 0;
	for (const job of Object.values(store)) {
		if (job.status !== 'running') continue;
		if (!isProcessAlive(job.pid)) {
			job.status = 'failed';
			job.error = 'Process died unexpectedly';
			job.finishedAt = new Date().toISOString();
			cleaned++;
		}
	}
	if (cleaned > 0) await persistStore();
	return cleaned;
}

export function getLogFilePath(ticketKey: string): string {
	const safeKey = ticketKey.replace(/[/\\]/g, '-');
	return path.join(LOGS_DIR, `${safeKey}-${Date.now()}.log`);
}

export function getLogsDir(): string {
	return LOGS_DIR;
}

export async function invalidateCache(): Promise<void> {
	jobCache = null;
}
