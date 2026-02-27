import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');

type CacheData = Record<string, unknown>;

async function ensureCacheDir(): Promise<void> {
	if (!existsSync(CACHE_DIR)) {
		await fs.mkdir(CACHE_DIR, { recursive: true });
	}
}

function cacheFilePath(key: string): string {
	return path.join(CACHE_DIR, `${key}.json`);
}

export async function getCached<T>(key: string): Promise<T | null> {
	const filePath = cacheFilePath(key);
	if (!existsSync(filePath)) return null;
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export async function setCached(key: string, value: unknown): Promise<void> {
	await ensureCacheDir();
	await fs.writeFile(cacheFilePath(key), JSON.stringify(value, null, 2), 'utf8');
}

export async function getAllCache(): Promise<CacheData> {
	await ensureCacheDir();
	const data: CacheData = {};
	const files = await fs.readdir(CACHE_DIR);
	for (const file of files) {
		if (!file.endsWith('.json')) continue;
		const key = file.replace(/\.json$/, '');
		try {
			const raw = await fs.readFile(path.join(CACHE_DIR, file), 'utf8');
			data[key] = JSON.parse(raw);
		} catch {
			// Skip corrupt cache files.
		}
	}
	return data;
}

export async function clearCache(): Promise<void> {
	if (existsSync(CACHE_DIR)) {
		await fs.rm(CACHE_DIR, { recursive: true, force: true });
	}
}
