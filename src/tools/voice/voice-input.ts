import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import chalk from 'chalk';

const esmRequire = createRequire(import.meta.url);

const SHERPA_MODELS_ROOT = path.join(os.homedir(), '.forgepilot', 'sherpa-models');
const MIN_RECORDING_MS = 1000;
const KEY_DEBOUNCE_MS = 500;

type VoiceModelId = 'tiny.en' | 'small.en' | 'medium.en' | 'large-v3';

type VoiceModelConfig = {
	id: VoiceModelId;
	dir: string;
	prefix: string;
	repo: string;
	sizeLabel: string;
};

const VOICE_MODELS: VoiceModelConfig[] = [
	{ id: 'tiny.en', dir: 'whisper-tiny.en', prefix: 'tiny.en', repo: 'csukuangfj/sherpa-onnx-whisper-tiny.en', sizeLabel: '~98 MB' },
	{ id: 'small.en', dir: 'whisper-small.en', prefix: 'small.en', repo: 'csukuangfj/sherpa-onnx-whisper-small.en', sizeLabel: '~200 MB' },
	{ id: 'medium.en', dir: 'whisper-medium.en', prefix: 'medium.en', repo: 'csukuangfj/sherpa-onnx-whisper-medium.en', sizeLabel: '~945 MB' },
	{ id: 'large-v3', dir: 'whisper-large-v3', prefix: 'large-v3', repo: 'csukuangfj/sherpa-onnx-whisper-large-v3', sizeLabel: '~1.7 GB' },
];

function getSelectedModelId(): VoiceModelId {
	const env = process.env.FORGEPILOT_VOICE_MODEL?.trim().toLowerCase();
	if (env && VOICE_MODELS.some((m) => m.id === env)) return env as VoiceModelId;
	return 'large-v3';
}

function getModelConfig(id?: VoiceModelId): VoiceModelConfig {
	const modelId = id ?? getSelectedModelId();
	return VOICE_MODELS.find((m) => m.id === modelId) ?? VOICE_MODELS[0];
}

function getModelDir(config: VoiceModelConfig): string {
	return path.join(SHERPA_MODELS_ROOT, config.dir);
}

function getModelPaths(config: VoiceModelConfig): { encoder: string; decoder: string; tokens: string } {
	const dir = getModelDir(config);
	return {
		encoder: path.join(dir, `${config.prefix}-encoder.int8.onnx`),
		decoder: path.join(dir, `${config.prefix}-decoder.int8.onnx`),
		tokens: path.join(dir, `${config.prefix}-tokens.txt`),
	};
}

function isModelDownloaded(config: VoiceModelConfig): boolean {
	const paths = getModelPaths(config);
	return existsSync(paths.encoder) && existsSync(paths.decoder) && existsSync(paths.tokens);
}

function downloadFile(url: string, dest: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn('curl', ['-L', '--progress-bar', '-o', dest, url], { stdio: 'inherit' });
		child.on('close', (code) => resolve(code === 0));
		child.on('error', () => resolve(false));
	});
}

export async function ensureVoiceModel(): Promise<VoiceModelConfig | null> {
	const config = getModelConfig();

	if (isModelDownloaded(config)) return config;

	console.log(chalk.bold(`\n  Whisper model "${config.id}" not found locally.`));
	console.log(chalk.gray(`  Download size: ${config.sizeLabel}`));
	console.log(chalk.gray(`  Location: ${getModelDir(config)}`));

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(chalk.cyan('  Download now? [Y/n] '), (a) => { rl.close(); resolve(a.trim()); });
	});
	if (process.stdin.readable) process.stdin.resume();

	if (answer.toLowerCase() === 'n') {
		console.log(chalk.yellow('  Skipped. Voice mode requires a model to function.'));
		return null;
	}

	const dir = getModelDir(config);
	mkdirSync(dir, { recursive: true });

	const baseUrl = `https://huggingface.co/${config.repo}/resolve/main`;
	const files = [
		{ url: `${baseUrl}/${config.prefix}-encoder.int8.onnx`, name: `${config.prefix}-encoder.int8.onnx` },
		{ url: `${baseUrl}/${config.prefix}-decoder.int8.onnx`, name: `${config.prefix}-decoder.int8.onnx` },
		{ url: `${baseUrl}/${config.prefix}-tokens.txt`, name: `${config.prefix}-tokens.txt` },
	];

	for (const file of files) {
		const dest = path.join(dir, file.name);
		if (existsSync(dest) && statSync(dest).size > 100) {
			console.log(chalk.gray(`  ${file.name} already exists, skipping.`));
			continue;
		}
		console.log(chalk.bold(`\n  Downloading ${file.name}...`));
		const ok = await downloadFile(file.url, dest);
		if (!ok) {
			console.log(chalk.red(`  Failed to download ${file.name}`));
			return null;
		}
	}

	console.log(chalk.green(`\n  ✓ Model "${config.id}" downloaded successfully.`));
	return config;
}

let _voiceModeActive = false;
interface SherpaStream {
	acceptWaveform(opts: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaRecognizer {
	createStream(): SherpaStream;
	decode(stream: SherpaStream): void;
	getResult(stream: SherpaStream): { text?: string };
}

interface SherpaModule {
	OfflineRecognizer: new (config: Record<string, unknown>) => SherpaRecognizer;
	readWave(path: string): { sampleRate: number; samples: Float32Array };
}

let sherpaRecognizer: SherpaRecognizer | null = null;
let sherpaModule: SherpaModule | null = null;
let activeTtsProcess: ChildProcess | null = null;

export function isVoiceModeActive(): boolean {
	return _voiceModeActive;
}

export function setVoiceModeActive(active: boolean): void {
	_voiceModeActive = active;
}

export function initRecognizer(modelConfig?: VoiceModelConfig): void {
	if (sherpaRecognizer) return;
	const config = modelConfig ?? getModelConfig();
	const paths = getModelPaths(config);

	sherpaModule = esmRequire('sherpa-onnx-node') as SherpaModule;
	sherpaRecognizer = new sherpaModule!.OfflineRecognizer({
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			whisper: {
				encoder: paths.encoder,
				decoder: paths.decoder,
			},
			tokens: paths.tokens,
			numThreads: 2,
			provider: 'cpu',
		},
	});
}

export function checkVoiceDependencies(): string | null {
	try {
		esmRequire.resolve('sherpa-onnx-node');
	} catch {
		return 'sherpa-onnx-node (npm install sherpa-onnx-node)';
	}
	try {
		execFileSync('which', ['rec'], { stdio: 'pipe' });
	} catch {
		return 'sox (rec)';
	}
	return null;
}

export function getTtsCommand(): string {
	return process.env.FORGEPILOT_VOICE_TTS?.trim() || 'say';
}

export function speak(text: string): void {
	const tts = getTtsCommand();
	try {
		if (activeTtsProcess) {
			try { activeTtsProcess.kill(); } catch { /* */ }
		}
		const sanitized = text.replace(/["`$]/g, '').slice(0, 200);
		activeTtsProcess = spawn(tts, [sanitized], { stdio: 'ignore' });
		activeTtsProcess.on('close', () => { activeTtsProcess = null; });
	} catch {
		// TTS not available
	}
}

export function printAndSpeak(text: string): void {
	console.log(chalk.cyan(`  🔊 ${text}`));
	speak(text);
}

export function killTts(): void {
	if (activeTtsProcess) {
		try { activeTtsProcess.kill(); } catch { /* */ }
		activeTtsProcess = null;
	}
}

export function getSherpaModelDir(): string {
	return getModelDir(getModelConfig());
}

export function getSherpaModule(): SherpaModule | null {
	return sherpaModule;
}

export function getSherpaRecognizer(): SherpaRecognizer | null {
	return sherpaRecognizer;
}

export async function recordAndTranscribe(): Promise<string | null> {
	killTts();

	const rawFile = path.join(os.tmpdir(), `forgepilot-qa-${Date.now()}-raw.wav`);
	const proc = spawn('rec', [rawFile, 'rate', '16000', 'channels', '1'], {
		stdio: ['ignore', 'ignore', 'ignore'],
	});
	const startedAt = Date.now();

	console.log(chalk.green('  🎙  Recording... press [Space] to stop'));

	await drainKeypressesInternal(KEY_DEBOUNCE_MS);

	const stopKey = await waitForKeyInternal(['space']);
	if (stopKey === 'quit') {
		try { proc.kill(); } catch { /* */ }
		return null;
	}

	const elapsed = Date.now() - startedAt;
	if (elapsed < MIN_RECORDING_MS) {
		await new Promise((r) => setTimeout(r, MIN_RECORDING_MS - elapsed));
	}

	await new Promise<void>((res) => {
		proc.on('close', () => res());
		try { proc.kill('SIGTERM'); } catch { res(); return; }
		setTimeout(res, 3000);
	});

	const pcmFile = rawFile.replace('-raw.wav', '.wav');

	try {
		if (!existsSync(rawFile)) {
			console.error(chalk.red('  Recording file not created.'));
			return null;
		}
		const rawSize = statSync(rawFile).size;
		if (rawSize < 1000) {
			console.error(chalk.yellow('  Recording too short. Speak longer.'));
			return null;
		}

		execSync(`sox "${rawFile}" -r 16000 -c 1 -b 16 "${pcmFile}" 2>/dev/null`, { timeout: 10000 });

		if (!existsSync(pcmFile)) {
			console.error(chalk.red('  WAV conversion failed.'));
			return null;
		}

		const wave = sherpaModule!.readWave(pcmFile);
		const stream = sherpaRecognizer!.createStream();
		stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
		sherpaRecognizer!.decode(stream);
		const result = sherpaRecognizer!.getResult(stream);
		const text = (result?.text ?? '').trim();

		if (!text || text === '[BLANK_AUDIO]') {
			return null;
		}
		console.log(chalk.bold(`  You said: "${text}"`));
		return text;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(chalk.red(`  Transcription failed: ${msg.slice(0, 200)}`));
		return null;
	} finally {
		try { unlinkSync(rawFile); } catch { /* */ }
		try { unlinkSync(pcmFile); } catch { /* */ }
	}
}

function waitForKeyInternal(accept: string[]): Promise<string> {
	return new Promise((resolve) => {
		const onKeypress = (_: unknown, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				cleanup();
				resolve('quit');
				return;
			}
			const name = key.name ?? '';
			if (accept.includes(name)) {
				cleanup();
				resolve(name);
			}
		};
		const cleanup = () => {
			process.stdin.removeListener('keypress', onKeypress);
		};
		process.stdin.on('keypress', onKeypress);
	});
}

function drainKeypressesInternal(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const noop = () => {};
		process.stdin.on('keypress', noop);
		setTimeout(() => {
			process.stdin.removeListener('keypress', noop);
			resolve();
		}, ms);
	});
}

export type InputModeResult =
	| { mode: 'voice' }
	| { mode: 'keyboard'; firstChar: string }
	| { mode: 'quit' };

export function waitForInputMode(): Promise<InputModeResult> {
	return new Promise((resolve) => {
		const onKeypress = (ch: string | undefined, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				cleanup();
				resolve({ mode: 'quit' });
				return;
			}
			if (key.name === 'space') {
				cleanup();
				resolve({ mode: 'voice' });
				return;
			}
			if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
				cleanup();
				resolve({ mode: 'keyboard', firstChar: ch });
				return;
			}
			if (key.name === 'return') {
				cleanup();
				resolve({ mode: 'keyboard', firstChar: '' });
				return;
			}
		};
		const cleanup = () => {
			process.stdin.removeListener('keypress', onKeypress);
		};
		process.stdin.on('keypress', onKeypress);
	});
}

const NUMBER_WORDS: Record<string, number> = {
	one: 1, two: 2, three: 3, four: 4, five: 5,
	six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
	first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

function parseSpokenNumber(text: string): number | null {
	const lower = text.toLowerCase().trim();
	const direct = parseInt(lower, 10);
	if (!isNaN(direct) && direct > 0) return direct;
	for (const [word, num] of Object.entries(NUMBER_WORDS)) {
		if (lower.includes(word)) return num;
	}
	return null;
}

export type VoiceOption = { id: string; label: string };

export async function askVoice(question: string, options?: VoiceOption[]): Promise<string> {
	printAndSpeak(question);

	if (options?.length) {
		console.log('');
		for (let i = 0; i < options.length; i++) {
			console.log(chalk.cyan(`  ${i + 1}. ${options[i].label}`));
		}
		console.log('');
		speak(`Choose a number from 1 to ${options.length}.`);
	}

	console.log(chalk.gray('  Press [Space] to record your answer...'));
	const startKey = await waitForKeyInternal(['space']);
	if (startKey === 'quit') return '';

	const transcript = await recordAndTranscribe();
	if (!transcript) return '';

	if (options?.length) {
		const num = parseSpokenNumber(transcript);
		if (num && num >= 1 && num <= options.length) {
			const chosen = options[num - 1];
			console.log(chalk.green(`  → Selected: ${chosen.label}`));
			return chosen.id;
		}

		const lower = transcript.toLowerCase();
		for (const opt of options) {
			const labelWords = opt.label.toLowerCase().split(/\s+/);
			const matchCount = labelWords.filter((w) => w.length > 3 && lower.includes(w)).length;
			if (matchCount >= 2 || lower.includes(opt.id.toLowerCase())) {
				console.log(chalk.green(`  → Selected: ${opt.label}`));
				return opt.id;
			}
		}

		printAndSpeak(`I didn't match that to an option. Using your answer as-is.`);
	}

	return transcript;
}
