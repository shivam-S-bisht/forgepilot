import readline from 'node:readline';
import chalk from 'chalk';
import {
	isVoiceModeActive,
	speak,
	printAndSpeak,
	recordAndTranscribe,
	waitForInputMode,
	type InputModeResult,
} from '../tools/voice/voice-input.js';
import { shouldUseSlackQa } from '../tools/slack/slack.js';

function askLine(prompt: string, prefill = ''): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	if (prefill) rl.write(prefill);
	return new Promise((resolve) =>
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		}),
	);
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

function matchTranscriptToOption(transcript: string, options: AskOption[]): string | null {
	const num = parseSpokenNumber(transcript);
	if (num && num >= 1 && num <= options.length) return options[num - 1].id;

	const lower = transcript.toLowerCase();
	for (const opt of options) {
		const labelWords = opt.label.toLowerCase().split(/\s+/);
		const matchCount = labelWords.filter((w) => w.length > 3 && lower.includes(w)).length;
		if (matchCount >= 2 || lower.includes(opt.id.toLowerCase())) return opt.id;
	}
	return null;
}

async function hybridInput(): Promise<InputModeResult> {
	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	console.log(chalk.gray('  [Space] to speak, or start typing...'));
	const result = await waitForInputMode();
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	return result;
}

export async function askUser(prompt: string): Promise<string> {
	if (isVoiceModeActive()) {
		printAndSpeak(prompt);
		const input = await hybridInput();
		if (input.mode === 'quit') return '';
		if (input.mode === 'voice') {
			const transcript = await recordAndTranscribe();
			return transcript ?? '';
		}
		return askLine(prompt, input.firstChar);
	}
	if (shouldUseSlackQa()) {
		const { askQuestionViaSlack } = await import('../tools/slack/slack.js');
		const answer = await askQuestionViaSlack(prompt, '', 0, 0);
		return answer ?? '';
	}
	return askLine(prompt);
}

export type AskOption = { id: string; label: string };

export async function askUserChoice(prompt: string, options: AskOption[]): Promise<string> {
	if (isVoiceModeActive()) {
		printAndSpeak(prompt);
		console.log('');
		for (let i = 0; i < options.length; i++) {
			console.log(chalk.cyan(`  ${i + 1}. ${options[i].label}`));
		}
		console.log('');
		speak(`Choose a number from 1 to ${options.length}.`);

		const input = await hybridInput();
		if (input.mode === 'quit') return options[0].id;
		if (input.mode === 'voice') {
			const transcript = await recordAndTranscribe();
			if (!transcript) return options[0].id;
			const matched = matchTranscriptToOption(transcript, options);
			if (matched) {
				const opt = options.find((o) => o.id === matched);
				if (opt) console.log(chalk.green(`  → Selected: ${opt.label}`));
				return matched;
			}
			printAndSpeak(`I didn't match that to an option. Defaulting to first.`);
			return options[0].id;
		}
		const prefilled = input.firstChar;
		const answer = await askLine(chalk.cyan(`  Choose (1-${options.length}): `), prefilled);
		const num = parseInt(answer, 10);
		if (num >= 1 && num <= options.length) return options[num - 1].id;
		return options[0].id;
	}
	if (shouldUseSlackQa()) {
		const { postAndWaitForSelection } = await import('../tools/slack/slack.js');
		const slackOptions = options.map((o) => ({ id: o.id, label: o.label }));
		const [selected] = await postAndWaitForSelection(prompt, slackOptions);
		return selected;
	}

	console.log(chalk.yellow(`\n  ${prompt}`));
	console.log('');
	for (let i = 0; i < options.length; i++) {
		console.log(chalk.cyan(`  ${i + 1}. ${options[i].label}`));
	}
	console.log('');

	const answer = await askLine(chalk.cyan(`  Choose (1-${options.length}): `));
	const num = parseInt(answer, 10);
	if (num >= 1 && num <= options.length) return options[num - 1].id;
	return options[0].id;
}
