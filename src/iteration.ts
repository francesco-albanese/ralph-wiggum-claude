import type { ChildProcess } from "node:child_process";
import { createCompletionDetector } from "./completion.js";
import { streamAgentText } from "./stream.js";

export type IterationOutcome =
	| "complete"
	| "continue"
	| "crashed"
	| "timed-out";

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
}

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

		let timedOut = false;
		const timer =
			opts.timeoutMs !== undefined
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
					}, opts.timeoutMs)
				: null;

		child.on("error", (err) => {
			if (timer !== null) clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (timer !== null) clearTimeout(timer);
			streaming
				.then(() => {
					if (timedOut) {
						resolve({ outcome: "timed-out", exitCode: code });
					} else if (detector.matched) {
						resolve({ outcome: "complete", exitCode: code });
					} else if (code === 0) {
						resolve({ outcome: "continue", exitCode: code });
					} else {
						resolve({ outcome: "crashed", exitCode: code });
					}
				})
				.catch(reject);
		});
	});
}
