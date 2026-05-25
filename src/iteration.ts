import type { ChildProcess } from "node:child_process";
import { createCompletionDetector } from "./completion.js";
import { streamAgentText } from "./stream.js";

export type IterationOutcome =
	| "complete"
	| "continue"
	| "crashed"
	| "timed-out"
	| "signal-killed";

export interface IterationResult {
	readonly outcome: IterationOutcome;
	/** Exit code if the agent exited (null if killed by signal). */
	readonly exitCode: number | null;
}

export interface RunIterationOptions {
	/**
	 * Spawn the agent subprocess. Injected for testability; production
	 * passes a thin wrapper around `child_process.spawn("claude", ...)`.
	 *
	 * Each iteration spawns a fresh process — no shared session.
	 */
	readonly spawn: () => ChildProcess;
	/** Where to forward agent text. */
	readonly out: NodeJS.WritableStream;
	/**
	 * Override the default `<promise>COMPLETE</promise>` sentinel
	 * with a regex (`--complete-signal`).
	 */
	readonly completeSignal?: RegExp;
	/** Per-iteration timeout in ms. If exceeded, SIGTERM the agent. */
	readonly timeoutMs?: number;
	/**
	 * Grace window (ms) between SIGTERM and SIGKILL when a timeout fires.
	 * After SIGKILL we wait the same grace once more before resolving as
	 * "timed-out" with no further wait on `close`, so an unkillable
	 * (zombie/D-state) child cannot hang the loop indefinitely.
	 */
	readonly hardKillGraceMs?: number;
}

const DEFAULT_HARD_KILL_GRACE_MS = 5_000;

/**
 * Run a single iteration: spawn the agent, stream its text to `out`,
 * watch for the completion signal, enforce the per-iteration timeout,
 * and resolve when the subprocess exits.
 */
export function runIteration(
	opts: RunIterationOptions,
): Promise<IterationResult> {
	return new Promise((resolve, reject) => {
		const child = opts.spawn();
		const stdout = child.stdout;
		if (stdout === null) {
			reject(new Error("agent subprocess produced no stdout"));
			return;
		}

		const detector = createCompletionDetector(
			opts.completeSignal !== undefined ? { pattern: opts.completeSignal } : {},
		);

		// Tee the agent's text stream: forward to `out`, also feed the detector.
		const sink: NodeJS.WritableStream = {
			write(chunk: string | Uint8Array): boolean {
				const text =
					typeof chunk === "string"
						? chunk
						: Buffer.from(chunk).toString("utf8");
				opts.out.write(text);
				detector.push(text);
				return true;
			},
			end(): void {
				/* no-op — owner of `out` decides flush */
			},
			// Minimal stub: only the two methods streamAgentText uses.
		} as unknown as NodeJS.WritableStream;

		const streaming = streamAgentText(stdout, sink);

		const hardKillGraceMs = opts.hardKillGraceMs ?? DEFAULT_HARD_KILL_GRACE_MS;

		let timedOut = false;
		let settled = false;
		let timer: NodeJS.Timeout | null = null;
		let hardKillTimer: NodeJS.Timeout | null = null;
		let safetyTimer: NodeJS.Timeout | null = null;

		const clearTimers = () => {
			if (timer !== null) clearTimeout(timer);
			if (hardKillTimer !== null) clearTimeout(hardKillTimer);
			if (safetyTimer !== null) clearTimeout(safetyTimer);
		};
		const safeResolve = (r: IterationResult) => {
			if (settled) return;
			settled = true;
			clearTimers();
			resolve(r);
		};
		const safeReject = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimers();
			reject(err);
		};

		if (opts.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				hardKillTimer = setTimeout(() => {
					child.kill("SIGKILL");
					// If even SIGKILL doesn't yield a `close` event (truly
					// unkillable — kernel zombie, D-state), resolve anyway
					// after another grace window so the loop can advance.
					safetyTimer = setTimeout(() => {
						safeResolve({ outcome: "timed-out", exitCode: null });
					}, hardKillGraceMs);
				}, hardKillGraceMs);
			}, opts.timeoutMs);
		}

		child.on("error", (err) => {
			safeReject(err);
		});
		child.on("close", (code, signal) => {
			streaming
				.then(() => {
					if (timedOut) {
						safeResolve({ outcome: "timed-out", exitCode: code });
					} else if (detector.matched) {
						safeResolve({ outcome: "complete", exitCode: code });
					} else if (code === 0) {
						safeResolve({ outcome: "continue", exitCode: code });
					} else if (signal !== null) {
						// Externally killed by signal (e.g. parent abort)
						// without our timeout firing: don't count as crashed.
						safeResolve({ outcome: "signal-killed", exitCode: code });
					} else {
						safeResolve({ outcome: "crashed", exitCode: code });
					}
				})
				.catch(safeReject);
		});
	});
}
