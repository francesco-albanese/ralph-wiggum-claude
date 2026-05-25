import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { IterationResult } from "./iteration.js";
import { pricedRunIteration, wireDisplay } from "./run.js";

const ZERO_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheCreateTokens: 0,
	cacheReadTokens: 0,
};

describe("wireDisplay", () => {
	it("opens a structured log under .ralph/logs/ inside the given repoRoot", async () => {
		const root = mkdtempSync(join(tmpdir(), "ralph-wire-"));
		const stack = wireDisplay({ repoRoot: root });
		try {
			expect(stack.log.path).toMatch(/\.ralph\/logs\//);
			// Drive a real write so the OS-level file shows up in
			// readdir — `createWriteStream` defers the open syscall
			// until the first write.
			stack.log.write({
				event: "invocation_start",
				ts: new Date().toISOString(),
				pid: 1,
			});
			await stack.log.close();
			expect(readdirSync(join(root, ".ralph/logs"))).toHaveLength(1);
		} finally {
			// `close()` already called above on the happy path; this
			// finally exists only for the test-fail branch.
		}
	});

	it("returns a cost calculator that reads from the bundled pricing JSON", async () => {
		const root = mkdtempSync(join(tmpdir(), "ralph-wire-"));
		const stack = wireDisplay({ repoRoot: root });
		try {
			expect(typeof stack.cost.pricingVersion()).toBe("string");
			expect(stack.cost.pricingVersion().length).toBeGreaterThan(0);
		} finally {
			await stack.log.close();
		}
	});

	it("renders the final stalled summary with the stall reason", async () => {
		const root = mkdtempSync(join(tmpdir(), "ralph-wire-"));
		const stack = wireDisplay({ repoRoot: root });
		const writes: string[] = [];
		const writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				writes.push(chunk.toString());
				return true;
			});

		try {
			stack.display.renderFinalSummary({
				iterations: 3,
				maxIter: 3,
				outcome: "stalled",
				stallReason: "max-iter",
				totalUsage: ZERO_USAGE,
			});
			const output = writes
				.join("")
				.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
				.trimEnd();
			expect(output).toContain("ralph: stalled (max-iter)");
		} finally {
			writeSpy.mockRestore();
			await stack.log.close();
		}
	});
});

describe("pricedRunIteration", () => {
	it("renders the iteration summary, threads totalUsage, and resolves the IterationResult", async () => {
		const root = mkdtempSync(join(tmpdir(), "ralph-prn-"));
		const stack = wireDisplay({ repoRoot: root });

		// Capture renderIterationSummary calls without coupling to its
		// implementation — wrap the real method with a spy.
		const renderSpy = vi.spyOn(stack.display, "renderIterationSummary");

		const doneCalls: Array<{
			iteration: number;
			result: IterationResult;
		}> = [];

		const runOne = pricedRunIteration({
			display: stack.display,
			log: stack.log,
			maxIter: 5,
			spawnRunIteration: async (consume, _iteration) => {
				// Drive `consume` with a tiny inline stream so the
				// accumulator is populated. If we skipped this, the
				// helper would NOT render (acc is undefined).
				const stdout = new PassThrough();
				const consumePromise = consume(stdout);
				stdout.write(
					`${JSON.stringify({
						type: "result",
						model: "claude-opus-4-7",
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					})}\n`,
				);
				stdout.end();
				await consumePromise;
				return {
					outcome: "continue",
					exitCode: 0,
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheCreateTokens: 0,
						cacheReadTokens: 0,
					},
					model: "claude-opus-4-7",
				} satisfies IterationResult;
			},
			onIterationDone: (iteration, result) => {
				doneCalls.push({ iteration, result });
			},
		});

		try {
			const result = await runOne(2);
			expect(result.outcome).toBe("continue");
			expect(renderSpy).toHaveBeenCalledTimes(1);
			expect(renderSpy.mock.calls[0]?.[0]?.iteration).toBe(2);
			expect(renderSpy.mock.calls[0]?.[0]?.maxIter).toBe(5);
			expect(doneCalls).toHaveLength(1);
			expect(doneCalls[0]?.iteration).toBe(2);
		} finally {
			await stack.log.close();
		}
	});

	it("skips rendering when consume was never invoked (no accumulator)", async () => {
		const root = mkdtempSync(join(tmpdir(), "ralph-prn-"));
		const stack = wireDisplay({ repoRoot: root });
		const renderSpy = vi.spyOn(stack.display, "renderIterationSummary");
		const doneSpy =
			vi.fn<(iteration: number, result: IterationResult) => void>();

		const runOne = pricedRunIteration({
			display: stack.display,
			log: stack.log,
			maxIter: 3,
			// `spawnRunIteration` resolves without ever calling `consume`
			// — e.g. the child crashed before producing any stdout. We
			// still want to surface the IterationResult, but the empty
			// summary box would be noise. Helper should stay silent.
			spawnRunIteration: async () => ({
				outcome: "crashed",
				exitCode: 1,
				usage: ZERO_USAGE,
			}),
			onIterationDone: doneSpy,
		});

		try {
			const result = await runOne(1);
			expect(result.outcome).toBe("crashed");
			expect(renderSpy).not.toHaveBeenCalled();
			expect(doneSpy).not.toHaveBeenCalled();
		} finally {
			await stack.log.close();
		}
	});
});
