import { describe, expect, it, vi } from "vitest";
import type { IterationOutcome, IterationResult } from "./iteration.js";
import { runInvocation } from "./loop.js";

function fakeIteration(outcome: IterationOutcome): IterationResult {
	return { outcome, exitCode: outcome === "complete" ? 0 : 1 };
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
