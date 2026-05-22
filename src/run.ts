import { spawn } from "node:child_process";
import { parseBranch } from "./branch.js";
import { streamAgentText } from "./stream.js";
import { type Worktree, WorktreeManager } from "./worktree.js";

export type RunOptions = {
	readonly branch: string;
};

/**
 * Walking-skeleton + worktree-isolation entrypoint:
 *   1. validate `--branch` against the semantic-prefix list
 *   2. capture target (base) branch on the host
 *   3. create `.ralph/worktrees/<slug>/` attached to the new source branch
 *   4. spawn Claude Code with cwd = worktree path, stream text to stdout
 *   5. push the source branch + open a draft PR against the captured base
 *   6. remove the worktree (clean exit, agent crash, or Ctrl-C)
 *   7. return the PR URL
 */
export async function runCommand(opts: RunOptions): Promise<string> {
	// Validate the branch up-front so a bad --branch fails before we touch git.
	parseBranch(opts.branch);

	const baseBranch = await captureBaseBranch();
	if (baseBranch.length === 0) {
		throw new Error("could not determine current branch (detached HEAD?)");
	}
	if (baseBranch === opts.branch) {
		throw new Error(
			`--branch ${opts.branch} matches the current branch; supply a new branch name`,
		);
	}

	await ensureCleanWorktree();

	let prUrl = "";

	const signalCtl = installSignalAbort();
	try {
		await runInWorktree({
			branch: opts.branch,
			repoRoot: process.cwd(),
			signal: signalCtl.signal,
			agent: async ({ cwd, signal }) => {
				await spawnClaude({ cwd, signal });

				const commitsAhead = await countCommitsAhead({
					cwd,
					base: baseBranch,
				});
				if (commitsAhead === 0) {
					throw new Error(
						`agent produced no commits on ${opts.branch}; refusing to open an empty PR`,
					);
				}

				await runProc({
					cmd: "git",
					args: ["push", "-u", "origin", opts.branch],
					cwd,
				});

				prUrl = await createDraftPr({
					cwd,
					base: baseBranch,
					head: opts.branch,
				});
			},
		});
	} finally {
		signalCtl.dispose();
	}

	return prUrl;
}

export type AgentContext = {
	readonly cwd: string;
	readonly signal: AbortSignal;
};

export type AgentRunner = (ctx: AgentContext) => Promise<void>;

export type RunInWorktreeOptions = {
	readonly branch: string;
	readonly repoRoot: string;
	readonly agent: AgentRunner;
	readonly signal?: AbortSignal;
};

/**
 * Orchestrates the worktree lifecycle around a single agent invocation.
 *
 * The agent runs with `cwd = worktree.path` and an `AbortSignal` it
 * MUST honour for fast Ctrl-C shutdown. The worktree is removed in a
 * `finally` block, so cleanup happens on every exit path:
 *   - clean return
 *   - thrown error (agent crash / push failure / etc.)
 *   - external abort (SIGINT/SIGTERM via `installSignalAbort`)
 */
export async function runInWorktree(opts: RunInWorktreeOptions): Promise<void> {
	const branch = parseBranch(opts.branch);
	const mgr = new WorktreeManager({ repoRoot: opts.repoRoot });

	let wt: Worktree | undefined;
	try {
		wt = await mgr.create(branch);

		const signal = opts.signal ?? new AbortController().signal;
		if (signal.aborted) {
			throw new Error("aborted before agent could start");
		}

		await opts.agent({ cwd: wt.path, signal });
	} finally {
		if (wt !== undefined) {
			await mgr.remove(wt);
		}
	}
}

/**
 * Wire SIGINT + SIGTERM to an AbortSignal. First signal aborts; second
 * lets the default handler kill the process for real. The returned
 * `dispose` must be called on every exit path so listeners don't
 * accumulate when ralph is invoked repeatedly in the same process.
 */
function installSignalAbort(): { signal: AbortSignal; dispose: () => void } {
	const ac = new AbortController();
	const dispose = () => {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	};
	const onSignal = (sig: NodeJS.Signals) => {
		dispose();
		console.error(`\nralph: received ${sig}, cleaning up...`);
		ac.abort();
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	return { signal: ac.signal, dispose };
}

async function ensureCleanWorktree(): Promise<void> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["status", "--porcelain"],
	});
	if (stdout.trim().length > 0) {
		throw new Error(
			"working tree is not clean; commit or stash changes before running ralph",
		);
	}
}

async function spawnClaude(ctx: AgentContext): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"claude",
			[
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
			],
			{ cwd: ctx.cwd, stdio: ["inherit", "pipe", "inherit"] },
		);

		const onAbort = () => {
			child.kill("SIGTERM");
		};
		if (ctx.signal.aborted) {
			onAbort();
		} else {
			ctx.signal.addEventListener("abort", onAbort, { once: true });
		}

		const stdout = child.stdout;
		if (stdout === null) {
			ctx.signal.removeEventListener("abort", onAbort);
			reject(new Error("claude subprocess produced no stdout"));
			return;
		}

		const streaming = streamAgentText(stdout, process.stdout);

		child.on("error", (err) => {
			ctx.signal.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code, signal) => {
			ctx.signal.removeEventListener("abort", onAbort);
			streaming
				.then(() => {
					if (ctx.signal.aborted) {
						reject(new Error("claude aborted by signal"));
					} else if (code === 0) {
						resolve();
					} else {
						const reason =
							signal !== null ? `signal ${signal}` : `code ${code}`;
						reject(new Error(`claude exited with ${reason}`));
					}
				})
				.catch(reject);
		});
	});
}

async function captureBaseBranch(): Promise<string> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["branch", "--show-current"],
	});
	return stdout.trim();
}

async function countCommitsAhead(args: {
	cwd: string;
	base: string;
}): Promise<number> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["rev-list", `${args.base}..HEAD`, "--count"],
		cwd: args.cwd,
	});
	const n = Number.parseInt(stdout.trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

async function createDraftPr(args: {
	cwd: string;
	base: string;
	head: string;
}): Promise<string> {
	const { stdout } = await runProc({
		cmd: "gh",
		args: [
			"pr",
			"create",
			"--draft",
			"--base",
			args.base,
			"--head",
			args.head,
			"--fill",
		],
		cwd: args.cwd,
	});
	return stdout.trim();
}

type ProcResult = {
	readonly stdout: string;
	readonly stderr: string;
};

function runProc(opts: {
	cmd: string;
	args: readonly string[];
	cwd?: string;
}): Promise<ProcResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(opts.cmd, opts.args as string[], {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				const trimmed = stderr.trim();
				const detail = trimmed.length > 0 ? `: ${trimmed}` : "";
				reject(
					new Error(
						`${opts.cmd} ${opts.args.join(" ")} exited with code ${code}${detail}`,
					),
				);
			}
		});
	});
}
