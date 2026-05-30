#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { cleanup, createDefaultPorts, formatCleanupReport } from "./cleanup.js";
import { AGENT_NAMES } from "./config/schema.js";
import {
	runDetachedCommand,
	statusCommand,
	stopCommand,
	tailCommand,
} from "./daemon.js";
import { runInit } from "./init/index.js";
import { runProc } from "./proc.js";
import { captureRepoRoot, runCommand } from "./run.js";
import {
	parsePositiveInt,
	type RawCliOptions,
	resolveRunOptions,
} from "./run-options.js";

function parseOptionalPid(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	return parsePositiveInt(value, "pid");
}

function nodeEnv(): NodeJS.ProcessEnv {
	return Reflect.get(process, "env") as NodeJS.ProcessEnv;
}

const program = new Command();

program
	.name("ralph")
	.description(
		"Ralph: spawn an AI coding agent in a loop, stream its work, ship a PR",
	)
	.version("0.0.0");

program
	.command("run")
	.description(
		"Run Claude Code in an iteration loop and open a PR for its commits",
	)
	.requiredOption(
		"--branch <name>",
		"Source branch the agent commits to (e.g. feat/foo)",
	)
	.option(
		"--max-iter <n>",
		"Max iterations before the invocation stalls (overrides ralph.config.json; default 10)",
	)
	.option(
		"--timeout-min <n>",
		"Per-iteration timeout in minutes; SIGTERMs the agent on hit (default 30)",
	)
	.option(
		"--complete-signal <regex>",
		"Regex overriding the <promise>COMPLETE</promise> sentinel (overrides ralph.config.json)",
	)
	.option(
		"--agent <name>",
		`Agent provider to run (${AGENT_NAMES.join("|")}); overrides ralph.config.json`,
	)
	.option("--model <id>", "Model id to run; overrides ralph.config.json")
	.option("--detach", "Run in the background and print pid + log path", false)
	.action(async (raw: RawCliOptions) => {
		try {
			const { detach, ...opts } = await resolveRunOptions({
				raw,
				cwd: process.cwd(),
			});
			if (detach) {
				const result = await runDetachedCommand(opts);
				console.log(`pid=${result.pid} log=${result.logPath}`);
				return;
			}
			const env = nodeEnv();
			const result = await runCommand({
				...opts,
				state: env.RALPH_DETACHED_STATE === "1",
				...(env.RALPH_DETACHED_LOG_PATH !== undefined
					? { logPath: env.RALPH_DETACHED_LOG_PATH }
					: {}),
			});

			if (result.outcome === "interrupted") {
				console.error(
					`ralph: interrupted after ${result.iterations} iteration(s)` +
						(result.crashes > 0 ? `, ${result.crashes} crash(es)` : "") +
						(result.prUrl.length > 0
							? `; draft PR left at ${result.prUrl}`
							: ""),
				);
				process.exit(130);
			}

			if (result.prUrl.length === 0) {
				// Agent completed with no commits — a legitimate no-op
				// success, distinct from a failure. Print to stderr so
				// scripts capturing stdout for the PR URL get an empty
				// value rather than a non-URL surprise.
				console.error("ralph: agent completed with no commits to ship");
			} else {
				if (result.qgError !== undefined) {
					// QG failed → PR is intentionally left DRAFT. Warn loudly
					// so the user knows the gate didn't run cleanly and a
					// human review is required before merging.
					console.error(
						`ralph: quality gate FAILED — PR left as DRAFT for human review: ${result.qgError}`,
					);
				}
				console.log(result.prUrl);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`ralph: ${msg}`);
			process.exit(1);
		}
	});

program
	.command("status")
	.description("List active detached Ralph runs")
	.action(async () => {
		try {
			await statusCommand();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`ralph: ${msg}`);
			process.exit(1);
		}
	});

program
	.command("tail")
	.description("Follow a detached Ralph run log")
	.argument("[pid]", "Process id to tail")
	.action(async (pid: string | undefined) => {
		try {
			await tailCommand(parseOptionalPid(pid));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`ralph: ${msg}`);
			process.exit(1);
		}
	});

program
	.command("stop")
	.description("Stop a detached Ralph run")
	.argument("[pid]", "Process id to stop")
	.action(async (pid: string | undefined) => {
		try {
			const state = await stopCommand(parseOptionalPid(pid));
			console.log(`sent SIGTERM to pid=${state.pid}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`ralph: ${msg}`);
			process.exit(1);
		}
	});

export type RawCleanupOptions = {
	readonly base?: string;
	readonly branch?: string;
	readonly apply?: boolean;
	readonly force?: boolean;
};

program
	.command("cleanup")
	.description(
		"List (or delete) local branches whose commits are already on origin",
	)
	.option(
		"--base <name>",
		"Remote base to compare against (origin/<base>). Defaults to the current branch.",
	)
	.option(
		"--branch <name>",
		"Target a single local branch instead of scanning all locals",
	)
	.option(
		"--apply",
		"Actually delete eligible branches (default: dry-run)",
		false,
	)
	.option("--force", "Allow deletion of branches with unpushed commits", false)
	.action(async (raw: RawCleanupOptions) => {
		try {
			const repoRoot = await captureRepoRoot();
			const ports = createDefaultPorts({ repoRoot });
			// Resolve the default base from the cwd the user invoked from,
			// NOT the main checkout — `repoRoot` is the main worktree path
			// (`git worktree list --porcelain` always lists it first), so
			// using it here would default to whatever branch the main
			// checkout happens to be on, even when ralph was run from a
			// linked worktree. `process.cwd()` mirrors normal `git`
			// CLI behaviour: the active worktree decides.
			const base = raw.base ?? (await captureCurrentBranch(process.cwd()));
			const report = await cleanup(ports, {
				base,
				...(raw.branch !== undefined ? { branch: raw.branch } : {}),
				apply: raw.apply === true,
				force: raw.force === true,
			});
			console.log(formatCleanupReport(report));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`ralph: ${msg}`);
			process.exit(1);
		}
	});

export type RawInitOptions = {
	readonly force?: boolean;
	readonly editor?: boolean;
};

program
	.command("init")
	.description(
		"Scaffold .ralph/ config + prompt + .env.example in the current project",
	)
	.option("--force", "Overwrite existing files without prompting", false)
	.option("--no-editor", "Skip opening the new prompt in $EDITOR at the end")
	.action(async (raw: RawInitOptions) => {
		try {
			await runInit({
				cwd: process.cwd(),
				force: raw.force === true,
				openEditor: raw.editor !== false,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`ralph: ${msg}`);
			process.exit(1);
		}
	});

async function captureCurrentBranch(repoRoot: string): Promise<string> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["branch", "--show-current"],
		cwd: repoRoot,
	});
	const branch = stdout.trim();
	if (branch.length === 0) {
		throw new Error(
			"could not determine current branch (detached HEAD?); pass --base <name>",
		);
	}
	return branch;
}

// Only auto-parse argv when this file is the entry point. Importing
// `cli.ts` (e.g. from tests) must not have side effects.
// `pathToFileURL` is used (vs. string-concatenating `file://`) so the
// check survives percent-encoded paths, Windows drive letters, and
// symlinked bins (pnpm/npm shims).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	program.parseAsync(process.argv).catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}
