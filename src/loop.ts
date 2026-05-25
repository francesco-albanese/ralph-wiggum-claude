import type { IterationResult } from "./iteration.js";

export type InvocationOutcome = "complete" | "stalled" | "interrupted";

export interface InvocationSummary {
	/**
	 * "complete" if the signal fired; "interrupted" if an iteration
	 * was killed by an external signal (Ctrl-C); "stalled" otherwise
	 * (max-iter / crash-rate).
	 */
	readonly outcome: InvocationOutcome;
	/** How many iterations actually ran. */
	readonly iterations: number;
	/** How many iterations exited non-zero. */
	readonly crashes: number;
	/** Why we stalled, if applicable. */
	readonly stallReason?: "max-iter" | "crash-rate";
}

export interface RunInvocationOptions {
	/** Hard ceiling on iterations (default 10). */
	readonly maxIter: number;
	/** Inject the per-iteration runner — keeps the loop pure for tests. */
	readonly runIteration: (iteration: number) => Promise<IterationResult>;
}

/**
 * Minimum iterations before the crash-rate guard is evaluated. With
 * a single iteration any crash would be a 100% crash rate, so we wait
 * for a representative sample before aborting.
 */
export const CRASH_RATE_MIN_SAMPLE = 3;

/**
 * Crash-rate threshold (>50%) that aborts the invocation as a stall.
 */
export const CRASH_RATE_THRESHOLD = 0.5;

/**
 * Drive the Ralph iteration loop until the agent emits the completion
 * signal, the max-iter ceiling is reached, or the crash rate aborts
 * the invocation. Pure orchestration — no agent spawning, no PR work.
 */
export async function runInvocation(
	opts: RunInvocationOptions,
): Promise<InvocationSummary> {
	let crashes = 0;
	for (let i = 1; i <= opts.maxIter; i += 1) {
		const result = await opts.runIteration(i);
		if (result.outcome === "crashed") crashes += 1;
		if (result.outcome === "complete") {
			return { outcome: "complete", iterations: i, crashes };
		}
		if (result.outcome === "signal-killed") {
			// External abort (Ctrl-C). Break the loop instead of spawning
			// another agent; let the caller print a partial summary and
			// exit with the interrupt status.
			return { outcome: "interrupted", iterations: i, crashes };
		}
		if (i >= CRASH_RATE_MIN_SAMPLE && crashes / i > CRASH_RATE_THRESHOLD) {
			return {
				outcome: "stalled",
				iterations: i,
				crashes,
				stallReason: "crash-rate",
			};
		}
	}
	return {
		outcome: "stalled",
		iterations: opts.maxIter,
		crashes,
		stallReason: "max-iter",
	};
}
