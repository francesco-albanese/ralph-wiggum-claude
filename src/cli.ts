#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { cleanup, createDefaultPorts, formatCleanupReport } from "./cleanup.js";
import { runProc } from "./proc.js";
import { captureRepoRoot, type RunOptions, runCommand } from "./run.js";

const DEFAULT_MAX_ITER = 10;
const DEFAULT_TIMEOUT_MIN = 30;

export interface RawCliOptions {
	readonly branch: string;
	readonly maxIter?: string;
	readonly timeoutMin?: string;
	readonly completeSignal?: string;
}

/**
 * Translate raw commander option strings into a validated
 * `RunOptions` shape. Pure so the CLI surface is unit-testable
 * (no real subprocess needed).
 */
export function parseRunOptions(raw: RawCliOptions): Required<
	Pick<RunOptions, "branch" | "maxIter" | "timeoutMin">
> & {
	readonly completeSignal?: RegExp;
} {
	const maxIter =
		raw.maxIter !== undefined
			? parsePositiveInt(raw.maxIter, "--max-iter")
			: DEFAULT_MAX_ITER;
	const timeoutMin =
		raw.timeoutMin !== undefined
			? parsePositiveInt(raw.timeoutMin, "--timeout-min")
			: DEFAULT_TIMEOUT_MIN;

	let completeSignal: RegExp | undefined;
	if (raw.completeSignal !== undefined) {
		try {
			completeSignal = new RegExp(raw.completeSignal);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`invalid --complete-signal regex: ${msg}`);
		}
	}

	return completeSignal !== undefined
		? { branch: raw.branch, maxIter, timeoutMin, completeSignal }
		: { branch: raw.branch, maxIter, timeoutMin };
}

function parsePositiveInt(value: string, flag: string): number {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== value.trim()) {
		throw new Error(`${flag} must be a positive integer (got ${value})`);
	}
	return n;
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
		"Maximum number of iterations before the invocation stalls",
		String(DEFAULT_MAX_ITER),
	)
	.option(
		"--timeout-min <n>",
		"Per-iteration timeout in minutes (SIGTERMs the agent on hit)",
		String(DEFAULT_TIMEOUT_MIN),
	)
	.option(
		"--complete-signal <regex>",
		"Regex that overrides the default <promise>COMPLETE</promise> sentinel",
	)
	.action(async (raw: RawCliOptions) => {
		try {
			const opts = parseRunOptions(raw);
			const result = await runCommand(opts);

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
				console.log(result.prUrl);
			}
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
