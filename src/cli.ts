#!/usr/bin/env node
import { Command } from "commander";
import { runCommand } from "./run.js";

const program = new Command();

program
	.name("ralph")
	.description(
		"Ralph: spawn an AI coding agent, stream its work, ship a draft PR",
	)
	.version("0.0.0");

program
	.command("run")
	.description(
		"Spawn a single Claude Code invocation and open a draft PR for its commits",
	)
	.requiredOption(
		"--branch <name>",
		"Source branch the agent commits to (e.g. feat/foo)",
	)
	.action(async (opts: { branch: string }) => {
		try {
			const prUrl = await runCommand({ branch: opts.branch });
			console.log(prUrl);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`ralph: ${msg}`);
			process.exit(1);
		}
	});

program.parseAsync(process.argv).catch((err) => {
	console.error(err);
	process.exit(1);
});
