import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { parseBranch } from "./branch.js";
import { addUsage, CostCalculator, EMPTY_USAGE } from "./cost.js";
import { type IterationAccumulator, StreamDisplay } from "./display.js";
import {
	type IterationResult,
	type IterationStreamSummary,
	type RunIterationOptions,
	runIteration,
} from "./iteration.js";
import { openLog, type StructuredLog } from "./log.js";
import { runInvocation } from "./loop.js";
import { runProc } from "./proc.js";
import {
	createDefaultQualityGatePorts,
	type QualityGateReport,
	runQualityGate,
} from "./quality-gate.js";
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
	/**
	 * Run the quality gate ONCE at the COMPLETE boundary, after the
	 * iteration loop has emitted the completion signal and before the
	 * PR is marked ready. Returns the report (title, body, follow-up
	 * bead IDs, whether an auto-fix commit was created).
	 *
	 * Skipped entirely when the run stalls or is interrupted — those
	 * states leave the PR draft for human review.
	 *
	 * `cwd` is closed over by the production wiring (it's the worktree
	 * path), so callers at the orchestrate layer only supply branch
	 * metadata + PR url.
	 */
	runQualityGate: (input: {
		readonly branch: string;
		readonly baseBranch: string;
		readonly prUrl: string;
	}) => Promise<QualityGateReport>;
	/** Run one iteration. Number is 1-based. */
	runIteration: (iteration: number) => Promise<IterationResult>;
}

export interface OrchestrationOptions {
	readonly branch: string;
	readonly maxIter: number;
	/**
	 * Per-iteration boundary hook forwarded to `runInvocation`. The
	 * `StreamDisplay` uses this in production to render the iteration
	 * summary box between iterations. Optional so unit tests of
	 * orchestration logic stay terse.
	 */
	readonly onIterationEnd?: (
		iteration: number,
		result: IterationResult,
	) => void | Promise<void>;
}

export interface OrchestrationResult {
	readonly outcome: "complete" | "stalled" | "interrupted";
	/**
	 * URL of the opened draft (or ready) PR.
	 *
	 * Empty string when the agent legitimately completed with zero
	 * commits (a "nothing-to-do" success — agent inspected the repo,
	 * decided no work was needed, emitted the completion signal),
	 * OR when an interrupt fired before any iteration produced commits.
	 * Callers should treat empty + outcome="complete" as a no-op
	 * success, not a failure.
	 */
	readonly prUrl: string;
	readonly iterations: number;
	/** How many iterations exited non-zero. */
	readonly crashes: number;
	readonly stallReason?: "max-iter" | "crash-rate";
	/**
	 * Quality gate report. Present iff `outcome === "complete"` AND
	 * `prUrl` is non-empty AND the QG actually ran (it can throw — see
	 * `qgError` for that case). Absent when QG was skipped (stalled /
	 * interrupted / no-commits-complete) or when the run never got
	 * far enough for a PR to exist.
	 */
	readonly qualityGate?: QualityGateReport;
	/**
	 * Set when the QG threw. The PR is intentionally left DRAFT so a
	 * human reviews — promoting a PR to ready behind a QG failure
	 * defeats the purpose of the gate.
	 */
	readonly qgError?: string;
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
		...(opts.onIterationEnd !== undefined
			? { onIterationEnd: opts.onIterationEnd }
			: {}),
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
				crashes: summary.crashes,
			};
		}
		if (summary.outcome === "interrupted") {
			// Ctrl-C before any commits — no PR to open, but not a
			// failure either. Surface the interrupt so the CLI can
			// exit 130 with a partial summary.
			return {
				outcome: "interrupted",
				prUrl: "",
				iterations: summary.iterations,
				crashes: summary.crashes,
			};
		}
		throw new Error(
			`agent produced no commits on ${branch}; refusing to open an empty PR`,
		);
	}

	let qualityGate: QualityGateReport | undefined;
	let qgError: string | undefined;
	if (summary.outcome === "complete") {
		// QG hook — runs EXACTLY ONCE per invocation, against the full
		// PR diff (base..HEAD), not per iteration. If QG throws (agent
		// crash, malformed structured output, gh failure), we leave the
		// PR draft so a human reviews — promoting a PR to ready behind
		// a QG failure defeats the purpose of the gate.
		try {
			qualityGate = await orch.runQualityGate({
				branch,
				baseBranch,
				prUrl,
			});
		} catch (err) {
			qgError = err instanceof Error ? err.message : String(err);
		}
		// markPrReady runs OUTSIDE the QG try/catch so a `gh pr ready` failure
		// surfaces as itself and isn't mislabeled as a quality-gate failure.
		if (qualityGate !== undefined) {
			await orch.markPrReady(prUrl);
		}
	}
	// "interrupted" and "stalled" intentionally leave the PR draft so a
	// reviewer sees the partial work.

	const result: OrchestrationResult = {
		outcome: summary.outcome,
		prUrl,
		iterations: summary.iterations,
		crashes: summary.crashes,
		...(summary.stallReason !== undefined
			? { stallReason: summary.stallReason }
			: {}),
		...(qualityGate !== undefined ? { qualityGate } : {}),
		...(qgError !== undefined ? { qgError } : {}),
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
export type RunCommandResult = {
	readonly outcome: "complete" | "stalled" | "interrupted";
	readonly prUrl: string;
	readonly iterations: number;
	readonly crashes: number;
	readonly stallReason?: "max-iter" | "crash-rate";
	readonly qualityGate?: QualityGateReport;
	readonly qgError?: string;
};

/**
 * Build the per-invocation display stack: structured JSON log,
 * cost calculator, and `StreamDisplay`. Extracted from `runCommand`
 * so the wiring is small and testable in isolation.
 *
 * The returned `log` is opened immediately — callers MUST drive it
 * through a `try { ... } finally { log.close(); }` to avoid leaking
 * the file descriptor on a thrown setup error.
 */
export type DisplayStack = {
	readonly log: StructuredLog;
	readonly cost: CostCalculator;
	readonly display: StreamDisplay;
};

export function wireDisplay(args: {
	readonly repoRoot: string;
	readonly completeSignal?: RegExp;
}): DisplayStack {
	const log = openLog(args.repoRoot);
	const cost = new CostCalculator();
	const display = new StreamDisplay({
		cost,
		log,
		// Forward --complete-signal so the "task closed" flag in the
		// per-iteration summary respects the user's override.
		...(args.completeSignal !== undefined
			? { completeSignal: args.completeSignal }
			: {}),
	});
	return { log, cost, display };
}

/**
 * Wrap `runIteration` so the per-iteration boundary renders the
 * iteration-summary box, accumulates totals, and logs start/end —
 * all in ONE place. The display accumulator is the single source of
 * truth: no shared `Map`, no closure smuggling between layers.
 *
 * `onIterationDone` is called after rendering so the caller can keep
 * a running `totalUsage` for the final summary box.
 */
export function pricedRunIteration(args: {
	readonly display: StreamDisplay;
	readonly log: StructuredLog;
	readonly maxIter: number;
	readonly spawnRunIteration: (
		consume: NonNullable<RunIterationOptions["consume"]>,
		iteration: number,
	) => Promise<IterationResult>;
	readonly onIterationDone: (
		iteration: number,
		result: IterationResult,
		acc: IterationAccumulator,
	) => void;
}): (iteration: number) => Promise<IterationResult> {
	return async (iteration: number): Promise<IterationResult> => {
		args.log.write({
			event: "iteration_start",
			ts: new Date().toISOString(),
			iteration,
		});

		// Bind the per-iteration accumulator into the consume callback
		// so the post-iteration render uses THIS iteration's numbers
		// without any cross-iteration state.
		let acc: IterationAccumulator | undefined;
		const consume = async (
			stdout: Readable,
		): Promise<IterationStreamSummary> => {
			acc = await args.display.consume(stdout, iteration);
			return acc.model !== undefined
				? { usage: acc.usage, taskClosed: acc.taskClosed, model: acc.model }
				: { usage: acc.usage, taskClosed: acc.taskClosed };
		};

		const result = await args.spawnRunIteration(consume, iteration);
		const endAcc =
			acc ??
			(result.model !== undefined
				? {
						usage: result.usage,
						cost: zeroCost(),
						model: result.model,
						taskClosed: result.outcome === "complete",
					}
				: {
						usage: result.usage,
						cost: zeroCost(),
						taskClosed: result.outcome === "complete",
					});

		if (acc !== undefined) {
			args.display.renderIterationSummary({
				iteration,
				maxIter: args.maxIter,
				acc,
				result,
			});
		} else {
			args.display.recordIterationEnd({ iteration, result, acc: endAcc });
		}
		args.onIterationDone(iteration, result, endAcc);
		return result;
	};
}

function zeroCost() {
	return {
		inputUsd: 0,
		outputUsd: 0,
		cacheCreateUsd: 0,
		cacheReadUsd: 0,
		totalUsd: 0,
	};
}

export async function runCommand(opts: RunOptions): Promise<RunCommandResult> {
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

	let orchResult: OrchestrationResult | undefined;

	const repoRoot = await captureRepoRoot();

	// `wireDisplay` opens the log file. Everything from here on must
	// run inside a try/finally that closes it, otherwise a thrown
	// `installGracefulShutdown` (or any later setup step) leaks the fd.
	const { log: structuredLog, display } = wireDisplay({
		repoRoot,
		...(opts.completeSignal !== undefined
			? { completeSignal: opts.completeSignal }
			: {}),
	});
	let totalUsage = EMPTY_USAGE;
	let shutdownDispose: (() => void) | null = null;
	try {
		structuredLog.write({
			event: "invocation_start",
			ts: new Date().toISOString(),
			pid: process.pid,
			branch: opts.branch,
			maxIter,
		});

		const shutdown = installGracefulShutdown();
		shutdownDispose = shutdown.dispose;
		await runInWorktree({
			branch: opts.branch,
			repoRoot,
			signal: shutdown.signal,
			forceSignal: shutdown.forceSignal,
			agent: async ({ cwd, signal, forceSignal }) => {
				const wrappedRunIteration = pricedRunIteration({
					display,
					log: structuredLog,
					maxIter,
					spawnRunIteration: (consume) =>
						runIteration({
							spawn: () => spawnAgent({ cwd, signal, forceSignal }),
							out: process.stdout,
							timeoutMs,
							consume,
							...(opts.completeSignal !== undefined
								? { completeSignal: opts.completeSignal }
								: {}),
						}),
					onIterationDone: (_iteration, result) => {
						totalUsage = addUsage(totalUsage, result.usage);
					},
				});

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
					runQualityGate: (input) =>
						runQualityGate(createDefaultQualityGatePorts({ cwd, repoRoot }), {
							...input,
							cwd,
						}),
					runIteration: wrappedRunIteration,
				};

				orchResult = await orchestrate(orch, {
					branch: opts.branch,
					maxIter,
				});
			},
		});
	} finally {
		shutdownDispose?.();
		const outcome = orchResult?.outcome ?? "interrupted";
		display.renderFinalSummary({
			iterations: orchResult?.iterations ?? 0,
			maxIter,
			outcome,
			totalUsage,
			...(orchResult?.stallReason !== undefined
				? { stallReason: orchResult.stallReason }
				: {}),
		});
		await structuredLog.close();
	}

	if (orchResult === undefined) {
		// runInWorktree exited without ever calling the agent runner.
		// Treat as interrupted-before-start so the CLI can still surface
		// a clear status (vs. a generic crash).
		return {
			outcome: "interrupted",
			prUrl: "",
			iterations: 0,
			crashes: 0,
		};
	}
	return orchResult;
}

export type AgentContext = {
	readonly cwd: string;
	/** Aborts on first SIGINT/SIGTERM — agent should drain gracefully. */
	readonly signal: AbortSignal;
	/**
	 * Aborts on second SIGINT/SIGTERM within the second-press window OR
	 * when the drain timeout elapses — agent (and any child it spawned)
	 * should be killed immediately. Distinct from `signal` so consumers
	 * can escalate SIGTERM → SIGKILL without re-wiring listeners.
	 */
	readonly forceSignal: AbortSignal;
};

export type AgentRunner = (ctx: AgentContext) => Promise<void>;

export type RunInWorktreeOptions = {
	readonly branch: string;
	readonly repoRoot: string;
	readonly agent: AgentRunner;
	readonly signal?: AbortSignal;
	readonly forceSignal?: AbortSignal;
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
		const forceSignal = opts.forceSignal ?? new AbortController().signal;
		if (signal.aborted) {
			// Already aborted by the time the worktree existed (Ctrl-C
			// during `git worktree add`). Don't throw — let the caller's
			// `orchResult === undefined` branch surface as `interrupted`
			// with exit 130, not a generic crash. The worktree still
			// cleans up via the finally below.
			return;
		}

		await opts.agent({ cwd: wt.path, signal, forceSignal });
	} finally {
		if (wt !== undefined) {
			await mgr.remove(wt);
		}
	}
}

export type GracefulShutdown = {
	/** Aborts on first SIGINT/SIGTERM. */
	readonly signal: AbortSignal;
	/**
	 * Aborts on second SIGINT/SIGTERM within `secondPressMs` of the first,
	 * OR when `drainMs` elapses after the first signal without the
	 * underlying work resolving.
	 */
	readonly forceSignal: AbortSignal;
	/**
	 * Remove all signal listeners and clear pending drain/second-press
	 * timers. Idempotent. Always call from a `finally` so listeners do
	 * not accumulate across repeated invocations in the same process.
	 */
	readonly dispose: () => void;
};

export type GracefulShutdownOptions = {
	/**
	 * Grace window between first signal and forced kill. Default 30s
	 * — matches the spec for SIGTERM drain on first Ctrl-C.
	 */
	readonly drainMs?: number;
	/**
	 * Window after the first signal in which a second signal escalates
	 * to forced kill. Default 5s. Subsequent signals outside this
	 * window are ignored (the drain timer still escalates at drainMs).
	 */
	readonly secondPressMs?: number;
	/** Where to print human-readable shutdown progress. Defaults to stderr. */
	readonly out?: NodeJS.WritableStream;
};

const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_SECOND_PRESS_MS = 5_000;

/**
 * Two-stage signal handler for graceful shutdown.
 *
 *   1. First SIGINT/SIGTERM aborts `signal` (consumers SIGTERM their
 *      children); a 30s drain timer is started that aborts `forceSignal`
 *      if the underlying work hasn't unwound by then.
 *   2. A second SIGINT/SIGTERM within 5s aborts `forceSignal` immediately
 *      (consumers SIGKILL their children) — escape hatch for unresponsive
 *      agents. Cleanup still runs via the caller's `finally` blocks.
 *
 * Listeners are registered via `process.on` (not `once`) so a second
 * press is observed; `dispose()` removes them. Always call `dispose()`
 * from a `finally` so listeners do not leak when ralph runs inside a
 * long-lived process or test suite.
 */
export function installGracefulShutdown(
	opts: GracefulShutdownOptions = {},
): GracefulShutdown {
	const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
	const secondPressMs = opts.secondPressMs ?? DEFAULT_SECOND_PRESS_MS;
	const out = opts.out ?? process.stderr;

	const ac = new AbortController();
	const forceAc = new AbortController();

	let firstSignalAt = 0;
	let drainTimer: NodeJS.Timeout | null = null;
	let secondPressTimer: NodeJS.Timeout | null = null;
	let disposed = false;

	const writeLine = (line: string) => {
		out.write(`${line}\n`);
	};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		if (drainTimer !== null) clearTimeout(drainTimer);
		if (secondPressTimer !== null) clearTimeout(secondPressTimer);
		drainTimer = null;
		secondPressTimer = null;
	};

	const escalate = (reason: string) => {
		if (forceAc.signal.aborted) return;
		writeLine(`ralph: ${reason}, escalating to force-kill...`);
		forceAc.abort();
	};

	const onSignal = (sig: NodeJS.Signals) => {
		const now = Date.now();
		if (firstSignalAt === 0) {
			firstSignalAt = now;
			writeLine(
				`\nralph: received ${sig}, draining for up to ${Math.round(
					drainMs / 1000,
				)}s (press Ctrl-C again to force-kill)...`,
			);
			ac.abort();
			drainTimer = setTimeout(
				() => escalate(`drain timeout (${Math.round(drainMs / 1000)}s)`),
				drainMs,
			);
			// Unref so a pending drain timer doesn't keep the event loop
			// alive after work resolves naturally.
			drainTimer.unref?.();
			secondPressTimer = setTimeout(() => {
				secondPressTimer = null;
			}, secondPressMs);
			secondPressTimer.unref?.();
		} else if (
			secondPressTimer !== null &&
			now - firstSignalAt <= secondPressMs
		) {
			escalate(`second ${sig} within ${Math.round(secondPressMs / 1000)}s`);
		}
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	return { signal: ac.signal, forceSignal: forceAc.signal, dispose };
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

	const onTerm = () => {
		child.kill("SIGTERM");
	};
	const onKill = () => {
		child.kill("SIGKILL");
	};

	if (ctx.signal.aborted) onTerm();
	else ctx.signal.addEventListener("abort", onTerm, { once: true });

	if (ctx.forceSignal.aborted) onKill();
	else ctx.forceSignal.addEventListener("abort", onKill, { once: true });

	child.once("close", () => {
		ctx.signal.removeEventListener("abort", onTerm);
		ctx.forceSignal.removeEventListener("abort", onKill);
	});

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
