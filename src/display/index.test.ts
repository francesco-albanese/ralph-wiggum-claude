import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CostCalculator, type PricingTable } from "../cost.js";
import { formatToolLine, StreamDisplay } from "../display.js";
import type { LogEvent, StructuredLog } from "../log.js";

const FIXTURE_PRICING: PricingTable = {
	version: "test",
	currency: "USD",
	unit: "per_million_tokens",
	models: {
		"claude-opus-4-7": {
			input: 15,
			output: 75,
			cacheCreate: 18.75,
			cacheRead: 1.5,
		},
	},
};

function memoryLog(): StructuredLog & { entries: LogEvent[] } {
	const entries: LogEvent[] = [];
	return {
		entries,
		path: ":memory:",
		write(event) {
			entries.push(event);
		},
		async close() {
			/* no-op */
		},
	};
}

describe("formatToolLine", () => {
	it("renders Bash tools with the command argument", () => {
		expect(formatToolLine("Bash", { command: "bd ready --json" }, 80)).toBe(
			"Bash: bd ready --json",
		);
	});

	it("renders Read tools with the file path", () => {
		expect(formatToolLine("Read", { file_path: "/abs/path/file.ts" }, 80)).toBe(
			"Read: /abs/path/file.ts",
		);
	});

	it("truncates long arguments with an ellipsis", () => {
		const long = "a".repeat(120);
		const out = formatToolLine("Bash", { command: long }, 20);
		// 20 chars total, last char is the ellipsis.
		expect(out.length).toBeLessThanOrEqual(20 + "Bash: ".length);
		expect(out).toMatch(/…$/);
	});

	it("collapses whitespace inside the argument", () => {
		expect(formatToolLine("Bash", { command: "ls   -la   \n   foo" }, 80)).toBe(
			"Bash: ls -la foo",
		);
	});

	it("falls back to JSON when no salient key is present", () => {
		const out = formatToolLine("Custom", { foo: 1, bar: 2 }, 80);
		expect(out).toBe('Custom: {"foo":1,"bar":2}');
	});

	it("returns just the name when there are no arguments", () => {
		expect(formatToolLine("Heartbeat", undefined, 80)).toBe("Heartbeat");
		expect(formatToolLine("Heartbeat", null, 80)).toBe("Heartbeat");
	});
});

describe("StreamDisplay.consume", () => {
	it("renders tool calls and prose, accumulates usage from the result event, and logs every parsed event", async () => {
		const log = memoryLog();
		const cost = new CostCalculator({
			pricing: FIXTURE_PRICING,
			warn: () => {},
		});
		const out = new PassThrough();
		const sink: string[] = [];
		out.on("data", (chunk: Buffer) => sink.push(chunk.toString("utf8")));

		const display = new StreamDisplay({ cost, log, out });

		const stdout = new PassThrough();
		const consumePromise = display.consume(stdout, 1);

		// Init -> model id.
		stdout.write(
			`${JSON.stringify({
				type: "system",
				subtype: "init",
				model: "claude-opus-4-7",
			})}\n`,
		);
		// Assistant text + tool_use.
		stdout.write(
			`${JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "thinking with secret-token" },
						{
							type: "tool_use",
							name: "Bash",
							input: { command: "echo secret-token" },
						},
					],
				},
			})}\n`,
		);
		// Completion sentinel in the prose.
		stdout.write(
			`${JSON.stringify({
				type: "assistant",
				message: {
					content: [{ type: "text", text: "<promise>COMPLETE</promise>" }],
				},
			})}\n`,
		);
		// Result event with the authoritative usage.
		stdout.write(
			`${JSON.stringify({
				type: "result",
				model: "claude-opus-4-7",
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_creation_input_tokens: 100,
					cache_read_input_tokens: 200,
				},
			})}\n`,
		);
		stdout.end();

		const acc = await consumePromise;

		expect(acc.taskClosed).toBe(true);
		expect(acc.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheCreateTokens: 100,
			cacheReadTokens: 200,
		});
		// 1000 in @ $15/M + 500 out @ $75/M + 100 cc @ $18.75/M + 200 cr @ $1.5/M
		// = 0.015 + 0.0375 + 0.001875 + 0.0003 = 0.054675
		expect(acc.cost.totalUsd).toBeCloseTo(0.054675, 6);
		expect(acc.model).toBe("claude-opus-4-7");

		// Rendered output includes the tool line and the prose chunks.
		const stripped = sink
			.join("")
			.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
		expect(stripped).toContain("Bash: echo secret-token");
		expect(stripped).toContain("thinking with secret-token");

		// Every parsed event is in the log, but text/tool payloads are redacted.
		const streamEvents = log.entries.filter((e) => e.event === "stream");
		expect(streamEvents.length).toBeGreaterThanOrEqual(5);
		expect(JSON.stringify(streamEvents)).not.toContain("secret-token");
		expect(streamEvents).toContainEqual(
			expect.objectContaining({
				payload: { kind: "tool_call", name: "Bash", input: "[redacted]" },
			}),
		);
	});

	it("detects completion deterministically with a global regex", async () => {
		const log = memoryLog();
		const display = new StreamDisplay({
			cost: new CostCalculator({ pricing: FIXTURE_PRICING, warn: () => {} }),
			log,
			out: new PassThrough(),
			completeSignal: /<promise>COMPLETE<\/promise>/g,
		});
		const stdout = new PassThrough();
		const consumePromise = display.consume(stdout, 1);
		stdout.write(
			`${JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "<promise>COMPLETE</promise>" },
						{ type: "text", text: " and still done" },
					],
				},
			})}\n`,
		);
		stdout.end();

		await expect(consumePromise).resolves.toMatchObject({ taskClosed: true });
	});
});
