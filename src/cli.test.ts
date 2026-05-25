import { describe, expect, it } from "vitest";
import { parseRunOptions } from "./cli.js";

describe("parseRunOptions", () => {
	it("applies the default max-iter (10) and timeout-min (30)", () => {
		const opts = parseRunOptions({ branch: "feat/x" });
		expect(opts).toMatchObject({
			branch: "feat/x",
			agent: "claude",
			maxIter: 10,
			timeoutMin: 30,
		});
		expect(opts.completeSignal).toBeUndefined();
	});

	it("parses --max-iter and --timeout-min as positive integers", () => {
		const opts = parseRunOptions({
			branch: "feat/x",
			maxIter: "5",
			timeoutMin: "45",
		});
		expect(opts.maxIter).toBe(5);
		expect(opts.timeoutMin).toBe(45);
	});

	it("rejects non-positive --max-iter", () => {
		expect(() => parseRunOptions({ branch: "feat/x", maxIter: "0" })).toThrow(
			/max-iter/i,
		);
		expect(() => parseRunOptions({ branch: "feat/x", maxIter: "abc" })).toThrow(
			/max-iter/i,
		);
	});

	it("rejects non-positive --timeout-min", () => {
		expect(() =>
			parseRunOptions({ branch: "feat/x", timeoutMin: "-3" }),
		).toThrow(/timeout-min/i);
	});

	it("compiles --complete-signal into a RegExp", () => {
		const opts = parseRunOptions({
			branch: "feat/x",
			completeSignal: "DONE_(SUCCESS|OK)",
		});
		expect(opts.completeSignal).toBeInstanceOf(RegExp);
		expect(opts.completeSignal?.test("DONE_OK")).toBe(true);
	});

	it("rejects an invalid --complete-signal regex with a clear error", () => {
		expect(() =>
			parseRunOptions({ branch: "feat/x", completeSignal: "[unclosed" }),
		).toThrow(/complete-signal/i);
	});

	it("parses --agent and defaults to claude", () => {
		expect(parseRunOptions({ branch: "feat/x" }).agent).toBe("claude");
		expect(parseRunOptions({ branch: "feat/x", agent: "codex" }).agent).toBe(
			"codex",
		);
	});

	it("rejects unsupported --agent", () => {
		expect(() => parseRunOptions({ branch: "feat/x", agent: "qwen" })).toThrow(
			/agent/i,
		);
	});
});
