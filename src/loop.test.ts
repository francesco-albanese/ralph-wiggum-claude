import { describe, expect, it, vi } from "vitest";
import type { IterationOutcome, IterationResult } from "./iteration.js";
import { runInvocation } from "./loop.js";

function fakeIteration(outcome: IterationOutcome): IterationResult {
	// Mirror the iteration-runner contract: signal-killed children have
	// no exit code (null), completed runs are exit-0, everything else
	// gets a non-zero stand-in.
	const exitCode =
		outcome === "complete" ? 0 : outcome === "signal-killed" ? null : 1;
	return { outcome, exitCode };
}

describe("runInvocation", () => {
	it("stops on the first iteration that emits the completion signal", async () => {
		const results: IterationResult[] = [
			fakeIteration("continue"),
			fakeIteration("complete"),
			fakeIteration("continue"),
		];
		const runOne = vi
			.fn<() => Promise<IterationResult>>()
			.mockImplementation(async () => {
				const next = results.shift();
				if (next === undefined) throw new Error("too many iterations");
				return next;
			});

		const summary = await runInvocation({
			maxIter: 10,
			runIteration: runOne,
		});

		expect(runOne).toHaveBeenCalledTimes(2);
		expect(summary.outcome).toBe("complete");
		expect(summary.iterations).toBe(2);
	});

	it("stalls when --max-iter is reached without a completion signal", async () => {
		const runOne = vi
			.fn<() => Promise<IterationResult>>()
			.mockResolvedValue(fakeIteration("continue"));

		const summary = await runInvocation({
			maxIter: 3,
			runIteration: runOne,
		});

		expect(runOne).toHaveBeenCalledTimes(3);
		expect(summary.outcome).toBe("stalled");
		expect(summary.stallReason).toBe("max-iter");
	});

	it("aborts as stalled when crash rate exceeds 50% (after a minimum sample)", async () => {
		// Threshold: only evaluate crash rate after iteration >= 3.
		// 1: continue, 2: crashed, 3: crashed, 4: crashed -> >50% at i=3.
		const results: IterationResult[] = [
			fakeIteration("continue"),
			fakeIteration("crashed"),
			fakeIteration("crashed"),
			fakeIteration("crashed"),
		];
		const runOne = vi
			.fn<() => Promise<IterationResult>>()
			.mockImplementation(async () => {
				const next = results.shift();
				if (next === undefined) throw new Error("too many iterations");
				return next;
			});

		const summary = await runInvocation({
			maxIter: 10,
			runIteration: runOne,
		});

		expect(runOne).toHaveBeenCalledTimes(3);
		expect(summary.outcome).toBe("stalled");
		expect(summary.stallReason).toBe("crash-rate");
	});

	it("breaks the loop and surfaces 'interrupted' when an iteration is killed by signal", async () => {
		// Regression guard: SIGINT must NOT cause the loop to spawn
		// another agent. Without the early-out, "signal-killed" falls
		// through and iteration 2 runs even though the user asked to stop.
		const results: IterationResult[] = [
			fakeIteration("continue"),
			fakeIteration("signal-killed"),
			fakeIteration("complete"),
		];
		const runOne = vi
			.fn<() => Promise<IterationResult>>()
			.mockImplementation(async () => {
				const next = results.shift();
				if (next === undefined) throw new Error("too many iterations");
				return next;
			});

		const summary = await runInvocation({
			maxIter: 10,
			runIteration: runOne,
		});

		expect(runOne).toHaveBeenCalledTimes(2);
		expect(summary.outcome).toBe("interrupted");
		expect(summary.iterations).toBe(2);
	});

	it("does not abort early when a single iteration crashes", async () => {
		// One crash on iteration 1 = 100% crash rate, but threshold is
		// >=3 iterations before evaluating. Loop must continue.
		const results: IterationResult[] = [
			fakeIteration("crashed"),
			fakeIteration("continue"),
			fakeIteration("complete"),
		];
		const runOne = vi
			.fn<() => Promise<IterationResult>>()
			.mockImplementation(async () => {
				const next = results.shift();
				if (next === undefined) throw new Error("too many iterations");
				return next;
			});

		const summary = await runInvocation({
			maxIter: 10,
			runIteration: runOne,
		});

		expect(runOne).toHaveBeenCalledTimes(3);
		expect(summary.outcome).toBe("complete");
	});
});
