import { type ChildProcess, spawn } from "node:child_process";
import { parseBranch } from "./branch.js";
import { type IterationResult, runIteration } from "./iteration.js";
import { runInvocation } from "./loop.js";
import { type Worktree, WorktreeManager } from "./worktree.js";

export interface RunOptions {
	readonly branch: string;
	/** Hard ceiling on iterations (default 10). */
	readonly maxIter?: number;
	/** Per-iteration timeout in minutes (default 30). */
	readonly timeoutMin?: number;
	/**
	 * Override the default `<promise>COMPLETE</promise>` sentinel
	 * with a regex string passed via `--complete-signal`.
	 */
	readonly completeSignal?: RegExp;
}

const DEFAULT_MAX_ITER = 10;
const DEFAULT_TIMEOUT_MIN = 30;

/**
 * Side effects abstracted out of the orchestration logic so that
 * `orchestrate` is unit-testable without spawning real subprocesses.
 * The production `runCommand` wires this to real `git`, `gh`, and
 * the Claude Code CLI; tests pass stubs.
 */
export interface Orchestrator {
	captureBaseBranch: () => Promise<string>;
	ensureCleanWorktree: () => Promise<void>;
	checkoutBranch: (branch: string) => Promise<void>;
	commitsAhead: (base: string) => Promise<number>;
	pushBranch: (branch: string) => Promise<void>;
	createDraftPr: (args: { base: string; head: string }) => Promise<string>;
	markPrReady: (url: string) => Promise<void>;
	/** Run one iteration. Number is 1-based. */
	runIteration: (iteration: number) => Promise<IterationResult>;
}

export interface OrchestrationOptions {
	readonly branch: string;
	readonly maxIter: number;
}

export interface OrchestrationResult {
	readonly outcome: "complete" | "stalled";
	/**
	 * URL of the opened draft (or ready) PR.
	 *
	 * Empty string when the agent legitimately completed with zero
	 * commits (a "nothing-to-do" success — agent inspected the repo,
	 * decided no work was needed, emitted the completion signal).
	 * Callers should treat empty + outcome="complete" as a no-op
	 * success, not a failure.
	 */
	readonly prUrl: string;
	readonly iterations: number;
	readonly stallReason?: "max-iter" | "crash-rate";
}

/**
 * Orchestrate one Ralph invocation:
 *   1. capture target (base) branch
 *   2. ensure working tree is clean
 *   3. checkout the supplied source branch
 *   4. run the iteration loop, opening a DRAFT PR the first time an
 *      iteration produces commits (so long/stalled runs surface work
 *      to humans early, not only after the loop exits)
 *   5. mark the PR ready iff the invocation completed via the signal
 *
 * Zero-commits + outcome="complete" is treated as a no-op success
 * (no PR opened, empty `prUrl`). Zero-commits + stalled throws — a
 * stalled run that produced nothing is a real failure to ship.
 */
export async function orchestrate(
	orch: Orchestrator,
	opts: OrchestrationOptions,
): Promise<OrchestrationResult> {
	const { branch, maxIter } = opts;

	const baseBranch = await orch.captureBaseBranch();
	if (baseBranch.length === 0) {
		throw new Error("could not determine current branch (detached HEAD?)");
	}
	if (baseBranch === branch) {
		throw new Error(
			`--branch ${branch} matches the current branch; supply a new branch name`,
		);
	}

	await orch.ensureCleanWorktree();

	await orch.checkoutBranch(branch);

	// Open the draft PR the first time an iteration produces commits.
	// We wrap `orch.runIteration` so the check + open happens INSIDE the
	// loop, between iterations — not after it exits. `prUrl` is the
	// guard against re-opening; subsequent iterations short-circuit.
	let prUrl: string | undefined;
	const summary = await runInvocation({
		maxIter,
		runIteration: async (iteration) => {
			const result = await orch.runIteration(iteration);
			if (prUrl === undefined) {
				const commits = await orch.commitsAhead(baseBranch);
				if (commits > 0) {
					await orch.pushBranch(branch);
					prUrl = await orch.createDraftPr({
						base: baseBranch,
						head: branch,
					});
				}
			}
			return result;
		},
	});

	if (prUrl === undefined) {
		// No iteration produced commits.
		if (summary.outcome === "complete") {
			// Agent completed cleanly with nothing to ship. Not a failure;
			// surface as a no-op success so the CLI can print a clear
			// message instead of an error.
			return {
				outcome: "complete",
				prUrl: "",
				iterations: summary.iterations,
			};
		}
		throw new Error(
			`agent produced no commits on ${branch}; refusing to open an empty PR`,
		);
	}

	if (summary.outcome === "complete") {
		await orch.markPrReady(prUrl);
	}

	const result: OrchestrationResult = {
		outcome: summary.outcome,
		prUrl,
		iterations: summary.iterations,
		...(summary.stallReason !== undefined
			? { stallReason: summary.stallReason }
			: {}),
	};
	return result;
}

/**
 * Production entry point used by the CLI. Wires `orchestrate` to:
 *   - the host's git for capturing the base branch on the host (BEFORE
 *     creating the worktree, so we don't end up reading the worktree's
 *     just-checked-out branch as the base)
 *   - `runInWorktree` for filesystem isolation: every iteration of the
 *     loop spawns `claude` with `cwd = .ralph/worktrees/<slug>/`, and
 *     the worktree is torn down in a `finally` (clean exit, crash, or
 *     SIGINT/SIGTERM via `installSignalAbort`)
 *   - `runIteration` (the per-iteration spawn + completion detector +
 *     per-iteration timeout) for each loop step
 *   - `gh` / `git push` against the worktree's `cwd` so they affect the
 *     isolated worktree's branch, never the host
 */
export async function runCommand(opts: RunOptions): Promise<string> {
	// Validate the branch up-front so a bad --branch fails before we
	// touch git (matches the walking-skeleton/worktree-isolation contract).
	parseBranch(opts.branch);

	const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
	const timeoutMin = opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
	const timeoutMs = timeoutMin * 60_000;

	// Capture the base branch on the host BEFORE we create the worktree,
	// otherwise the worktree's checkout would shadow the host's HEAD.
	const baseBranch = await hostCaptureBaseBranch();
	await hostEnsureCleanWorktree();

	let prUrl = "";

	const repoRoot = await captureRepoRoot();

	const signalCtl = installSignalAbort();
	try {
		await runInWorktree({
			branch: opts.branch,
			repoRoot,
			signal: signalCtl.signal,
			agent: async ({ cwd, signal }) => {
				const orch: Orchestrator = {
					// Base is already captured on the host; surface it to
					// `orchestrate` unchanged.
					captureBaseBranch: async () => baseBranch,
					// Host cleanliness is enforced above; the worktree itself
					// is freshly attached to the source branch, so there is
					// nothing to clean in the worktree's cwd.
					ensureCleanWorktree: async () => {
						/* no-op: worktree is fresh */
					},
					// `runInWorktree` already attached the worktree to the
					// source branch (`git worktree add -b <branch>`), so a
					// second `git checkout -b` would fail. No-op preserves
					// the orchestrate() contract without re-checking out.
					checkoutBranch: async (_branch: string) => {
						/* no-op: worktree is already on the source branch */
					},
					commitsAhead: (base) => defaultCommitsAhead(cwd, base),
					pushBranch: (branch) => defaultPushBranch(cwd, branch),
					createDraftPr: (args) => defaultCreateDraftPr(cwd, args),
					markPrReady: (url) => defaultMarkPrReady(cwd, url),
					runIteration: () =>
						runIteration({
							spawn: () => spawnAgent({ cwd, signal }),
							out: process.stdout,
							timeoutMs,
							...(opts.completeSignal !== undefined
								? { completeSignal: opts.completeSignal }
								: {}),
						}),
				};

				const result = await orchestrate(orch, {
					branch: opts.branch,
					maxIter,
				});
				prUrl = result.prUrl;
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

async function hostEnsureCleanWorktree(): Promise<void> {
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

async function hostCaptureBaseBranch(): Promise<string> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["branch", "--show-current"],
	});
	const base = stdout.trim();
	if (base.length === 0) {
		throw new Error("could not determine current branch (detached HEAD?)");
	}
	return base;
}

// Resolve the MAIN checkout's path so `.ralph/worktrees/` lands at the
// top of the user's repo, regardless of which subdirectory ralph was
// invoked from AND regardless of whether the cwd is itself a linked
// worktree (e.g., a nested ralph invocation inside .ralph/worktrees/<x>/).
// `git rev-parse --show-toplevel` would return the linked worktree's
// path and cause nesting; `git worktree list --porcelain` always lists
// the main worktree first.
export async function captureRepoRoot(): Promise<string> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["worktree", "list", "--porcelain"],
	});
	const firstLine = stdout.split(/\r?\n/, 1)[0] ?? "";
	const match = firstLine.match(/^worktree (.+)$/);
	const root = match?.[1];
	if (root === undefined) {
		throw new Error(
			"could not resolve git repo root from `git worktree list`; is the current directory inside a git repo?",
		);
	}
	return root;
}

/**
 * Spawn the Claude Code CLI in the given worktree cwd. The returned
 * ChildProcess is what `runIteration` (from iteration.ts) expects: it
 * owns the stdout-streaming, completion detection, and per-iteration
 * timeout. We just wire the abort signal here so Ctrl-C SIGTERMs the
 * subprocess.
 */
function spawnAgent(ctx: AgentContext): ChildProcess {
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
		child.once("close", () => {
			ctx.signal.removeEventListener("abort", onAbort);
		});
	}

	return child;
}

async function defaultCommitsAhead(cwd: string, base: string): Promise<number> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["rev-list", `${base}..HEAD`, "--count"],
		cwd,
	});
	const n = Number.parseInt(stdout.trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

async function defaultPushBranch(cwd: string, branch: string): Promise<void> {
	await runProc({
		cmd: "git",
		args: ["push", "-u", "origin", branch],
		cwd,
	});
}

async function defaultCreateDraftPr(
	cwd: string,
	args: { base: string; head: string },
): Promise<string> {
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
		cwd,
	});
	return stdout.trim();
}

async function defaultMarkPrReady(cwd: string, url: string): Promise<void> {
	await runProc({ cmd: "gh", args: ["pr", "ready", url], cwd });
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
