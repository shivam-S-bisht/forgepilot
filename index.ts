#!/usr/bin/env node

import chalk from 'chalk';
import { startInteractiveCli } from './src/cli.js';
import { fetchBoards, fetchMyCurrentAndFutureSprintIssues } from './src/jira.js';

async function main() {
	try {
		console.log(chalk.bold('Fetching your Jira tickets...'));
		console.log(chalk.gray('Using authenticated acli session'));
		const [boards, tickets] = await Promise.all([fetchBoards(), fetchMyCurrentAndFutureSprintIssues()]);
		await startInteractiveCli(tickets, boards);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: ${message}`);
		console.error('\nMake sure `acli auth login` is completed and Jira access is available.');
		process.exit(1);
	}
}

main();
