import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { unlinkSync, existsSync, statSync } from 'node:fs';
import chalk from 'chalk';

const esmRequire = createRequire(import.meta.url);

const SHERPA_MODEL_DIR = path.join(os.homedir(), '.forgepilot', 'sherpa-models', 'whisper-tiny.en');
const MIN_RECORDING_MS = 1000;
const KEY_DEBOUNCE_MS = 500;

let _voiceModeActive = false;
let sherpaRecognizer: any = null;
let sherpaModule: any = null;
let activeTtsProcess: ChildProcess | null = null;

export function isVoiceModeActive(): boolean {
	return _voiceModeActive;
}

export function setVoiceModeActive(active: boolean): void {
	_voiceModeActive = active;
}

export function initRecognizer(): void {
	if (sherpaRecognizer) return;
	sherpaModule = esmRequire('sherpa-onnx-node');
	sherpaRecognizer = new sherpaModule.OfflineRecognizer({
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			whisper: {
				encoder: path.join(SHERPA_MODEL_DIR, 'tiny.en-encoder.int8.onnx'),
				decoder: path.join(SHERPA_MODEL_DIR, 'tiny.en-decoder.int8.onnx'),
			},
			tokens: path.join(SHERPA_MODEL_DIR, 'tiny.en-tokens.txt'),
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
	const encoder = path.join(SHERPA_MODEL_DIR, 'tiny.en-encoder.int8.onnx');
	if (!existsSync(encoder)) {
		return `whisper model files in ${SHERPA_MODEL_DIR}`;
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
	return SHERPA_MODEL_DIR;
}

export function getSherpaModule(): any {
	return sherpaModule;
}

export function getSherpaRecognizer(): any {
	return sherpaRecognizer;
}

export function recordAndTranscribe(): Promise<string | null> {
	return new Promise(async (resolve) => {
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
			resolve(null);
			return;
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
				resolve(null);
				return;
			}
			const rawSize = statSync(rawFile).size;
			if (rawSize < 1000) {
				console.error(chalk.yellow('  Recording too short. Speak longer.'));
				resolve(null);
				return;
			}

			execSync(`sox "${rawFile}" -r 16000 -c 1 -b 16 "${pcmFile}" 2>/dev/null`, { timeout: 10000 });

			if (!existsSync(pcmFile)) {
				console.error(chalk.red('  WAV conversion failed.'));
				resolve(null);
				return;
			}

			const wave = sherpaModule.readWave(pcmFile);
			const stream = sherpaRecognizer.createStream();
			stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
			sherpaRecognizer.decode(stream);
			const result = sherpaRecognizer.getResult(stream);
			const text = (result?.text ?? '').trim();

			if (!text || text === '[BLANK_AUDIO]') {
				resolve(null);
				return;
			}
			console.log(chalk.bold(`  You said: "${text}"`));
			resolve(text);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(chalk.red(`  Transcription failed: ${msg.slice(0, 200)}`));
			resolve(null);
		} finally {
			try { unlinkSync(rawFile); } catch { /* */ }
			try { unlinkSync(pcmFile); } catch { /* */ }
		}
	});
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
