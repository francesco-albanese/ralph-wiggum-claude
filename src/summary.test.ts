import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CostBreakdown } from "./cost.js";
import {
	type FinalSummary,
	fmtTokens,
	fmtUsd,
	type IterationSummary,
	renderFinalSummary,
	renderIterationSummary,
} from "./summary.js";

function capture(fn: (out: PassThrough) => void): string {
	const buf: string[] = [];
	const stream = new PassThrough();
	stream.on("data", (chunk: Buffer) => buf.push(chunk.toString("utf8")));
	fn(stream);
	stream.end();
	// Strip ANSI escapes so the snapshot is readable and stable.
	// Pattern built from a string to avoid the control-char-in-regex lint.
	const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	return buf.join("").replace(ansiRe, "").trimEnd();
}

const breakdown = (totalUsd: number): CostBreakdown => ({
	inputUsd: totalUsd * 0.3,
	outputUsd: totalUsd * 0.5,
	cacheCreateUsd: totalUsd * 0.15,
	cacheReadUsd: totalUsd * 0.05,
	totalUsd,
});

describe("renderIterationSummary", () => {
	it("renders an iteration box with tokens, cost, and the model line", () => {
		const summary: IterationSummary = {
			iteration: 2,
			maxIter: 10,
			taskClosed: false,
			usage: {
				inputTokens: 1200,
				outputTokens: 340,
				cacheCreateTokens: 50,
				cacheReadTokens: 9000,
			},
			cost: breakdown(0.0123),
			model: "claude-opus-4-7",
		};
		const out = capture((s) => renderIterationSummary(summary, s));
		expect(out).toContain("iteration 2/10");
		expect(out).toContain("tokens");
		expect(out).toContain("in 1.2k");
		expect(out).toContain("out 340");
		expect(out).toContain("cache");
		expect(out).toContain("cost");
		expect(out).toContain("$0.0123");
		expect(out).toContain("claude-opus-4-7");
		// "task closed" only appears when the agent completed.
		expect(out).not.toContain("task closed");
	});

	it("flags 'task closed' when the iteration emitted the completion signal", () => {
		const summary: IterationSummary = {
			iteration: 3,
			maxIter: 3,
			taskClosed: true,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreateTokens: 0,
				cacheReadTokens: 0,
			},
			cost: breakdown(0),
		};
		const out = capture((s) => renderIterationSummary(summary, s));
		expect(out).toContain("iteration 3/3");
		expect(out).toContain("task closed");
	});
});

describe("renderFinalSummary", () => {
	it("renders cumulative totals for a complete invocation", () => {
		const summary: FinalSummary = {
			iterations: 4,
			maxIter: 10,
			outcome: "complete",
			totalUsage: {
				inputTokens: 5_000,
				outputTokens: 2_500,
				cacheCreateTokens: 100,
				cacheReadTokens: 50_000,
			},
			totalCost: breakdown(1.2345),
		};
		const out = capture((s) => renderFinalSummary(summary, s));
		expect(out).toContain("ralph: complete");
		expect(out).toContain("iterations  4/10");
		expect(out).toContain("$1.2345");
		expect(out).not.toContain("(max-iter)");
	});

	it("includes the stall reason in the title", () => {
		const summary: FinalSummary = {
			iterations: 10,
			maxIter: 10,
			outcome: "stalled",
			stallReason: "max-iter",
			totalUsage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreateTokens: 0,
				cacheReadTokens: 0,
			},
			totalCost: breakdown(0),
		};
		const out = capture((s) => renderFinalSummary(summary, s));
		expect(out).toContain("ralph: stalled (max-iter)");
	});
});

describe("formatters", () => {
	it("fmtTokens compacts large numbers", () => {
		expect(fmtTokens(0)).toBe("0");
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(1_500)).toBe("1.5k");
		expect(fmtTokens(2_500_000)).toBe("2.50M");
	});

	it("fmtUsd shows 4 decimal places so micro-costs are visible", () => {
		expect(fmtUsd(0)).toBe("$0.0000");
		expect(fmtUsd(0.0042)).toBe("$0.0042");
		expect(fmtUsd(12.3)).toBe("$12.3000");
	});
});
