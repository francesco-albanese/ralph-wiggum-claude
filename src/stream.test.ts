import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CostCalculator, loadBundledPricing } from "./cost.js";
import {
	type IterationUsage,
	type ParsedStreamEvent,
	streamAgentEvents,
} from "./stream.js";

/**
 * Pump a list of stream-JSON lines through a `PassThrough` so we can
 * drive `streamAgentEvents` from a synchronous fixture. Each entry
 * is JSON-stringified and terminated with `\n` to match the
 * one-object-per-line contract of `claude --output-format stream-json`.
 */
async function pumpFixture(
	lines: readonly unknown[],
): Promise<ParsedStreamEvent[]> {
	const stdout = new PassThrough();
	const collected: ParsedStreamEvent[] = [];
	const reader = (async () => {
		for await (const event of streamAgentEvents(stdout)) {
			collected.push(event);
		}
	})();
	for (const line of lines) {
		stdout.write(`${JSON.stringify(line)}\n`);
	}
	stdout.end();
	await reader;
	return collected;
}

// A realistic combined capture: system init, two assistant turns each
// reporting their own (cumulative-ish) usage, one tool_use, and the
// terminal `result` event with the AUTHORITATIVE final usage. We must
// emit a single `usage` ParsedStreamEvent — sourced from `result`.
const REALISTIC_CAPTURE: readonly unknown[] = [
	{ type: "system", subtype: "init", model: "claude-opus-4-7" },
	{
		type: "assistant",
		message: {
			content: [{ type: "text", text: "Looking at the repo..." }],
			usage: {
				input_tokens: 1200,
				output_tokens: 50,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		},
	},
	{
		type: "assistant",
		message: {
			content: [
				{ type: "tool_use", name: "Bash", input: { command: "bd ready" } },
			],
			usage: {
				input_tokens: 1300,
				output_tokens: 80,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		},
	},
	{
		type: "assistant",
		message: {
			content: [{ type: "text", text: "<promise>COMPLETE</promise>" }],
			usage: {
				input_tokens: 1500,
				output_tokens: 120,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		},
	},
	// Terminal event — Claude Code's authoritative final usage.
	{
		type: "result",
		model: "claude-opus-4-7",
		usage: {
			input_tokens: 1500,
			output_tokens: 120,
			cache_creation_input_tokens: 200,
			cache_read_input_tokens: 5000,
		},
	},
];

describe("streamAgentEvents — usage discrimination", () => {
	it("emits exactly one usage event sourced from the terminal `result`", async () => {
		const events = await pumpFixture(REALISTIC_CAPTURE);

		const usageEvents = events.filter(
			(e): e is Extract<ParsedStreamEvent, { kind: "usage" }> =>
				e.kind === "usage",
		);

		// Critical: only ONE usage event. If assistant.usage were
		// surfaced, we'd have four (three assistant + one result).
		expect(usageEvents).toHaveLength(1);

		// And the numbers match `result.usage` (NOT any of the
		// intermediate assistant snapshots), so cost computed from
		// these events equals the agent's authoritative total.
		const expected: IterationUsage = {
			inputTokens: 1500,
			outputTokens: 120,
			cacheCreateTokens: 200,
			cacheReadTokens: 5000,
		};
		expect(usageEvents[0]?.usage).toEqual(expected);
		expect(usageEvents[0]?.model).toBe("claude-opus-4-7");
	});

	it("still emits init, text, and tool events from the realistic capture", async () => {
		const events = await pumpFixture(REALISTIC_CAPTURE);
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("init");
		expect(kinds).toContain("text");
		expect(kinds).toContain("tool");
		// And the order is preserved: init first, result-derived usage last.
		expect(kinds[0]).toBe("init");
		expect(kinds[kinds.length - 1]).toBe("usage");
	});

	it("emits NO usage event when the stream lacks a terminal `result` event", async () => {
		// Inverse fixture: agent only emitted assistant messages with
		// their own usage snapshots, and crashed/timed out before the
		// `result` event. We DELIBERATELY report $0 (no usage event)
		// rather than silently fall back to a possibly-stale assistant
		// snapshot — the user sees zero, knows something is off, and
		// can investigate via the structured log.
		const events = await pumpFixture([
			{ type: "system", subtype: "init", model: "claude-opus-4-7" },
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "partial..." }],
					usage: {
						input_tokens: 800,
						output_tokens: 40,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
			},
		]);

		const usageEvents = events.filter((e) => e.kind === "usage");
		expect(usageEvents).toHaveLength(0);
	});

	it("skips a `result` event whose usage is all zeros", async () => {
		// Guard against an upstream bug surfacing as $0 — parseUsage
		// treats an all-zero block as "no signal" rather than a real
		// observation. This matches the same defence inside parseUsage.
		const events = await pumpFixture([
			{
				type: "result",
				model: "claude-opus-4-7",
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			},
		]);
		expect(events.filter((e) => e.kind === "usage")).toHaveLength(0);
	});

	it("normalizes OpenAI Responses usage from response.completed", async () => {
		const events = await pumpFixture([
			{
				type: "response.created",
				response: {
					model: "gpt-5.3-codex",
					usage: null,
				},
			},
			{
				type: "response.completed",
				response: {
					model: "gpt-5.3-codex",
					usage: {
						input_tokens: 1200,
						input_tokens_details: {
							cached_tokens: 300,
						},
						output_tokens: 90,
						output_tokens_details: {
							reasoning_tokens: 12,
						},
						total_tokens: 1290,
					},
				},
			},
		]);

		const usageEvents = events.filter(
			(e): e is Extract<ParsedStreamEvent, { kind: "usage" }> =>
				e.kind === "usage",
		);
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]?.model).toBe("gpt-5.3-codex");
		expect(usageEvents[0]?.usage).toEqual({
			inputTokens: 900,
			outputTokens: 90,
			cacheCreateTokens: 0,
			cacheReadTokens: 300,
		});
	});

	it("tolerates OpenAI Responses usage without cached-token details", async () => {
		const events = await pumpFixture([
			{
				type: "response.completed",
				response: {
					model: "gpt-5.5",
					usage: {
						input_tokens: 1200,
						output_tokens: 90,
						total_tokens: 1290,
					},
				},
			},
		]);

		const usageEvents = events.filter(
			(e): e is Extract<ParsedStreamEvent, { kind: "usage" }> =>
				e.kind === "usage",
		);
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]?.usage).toEqual({
			inputTokens: 1200,
			outputTokens: 90,
			cacheCreateTokens: 0,
			cacheReadTokens: 0,
		});
	});

	it("feeds OpenAI cached input into cost calculation without double-billing", async () => {
		const events = await pumpFixture([
			{
				type: "response.completed",
				response: {
					model: "gpt-5.3-codex",
					usage: {
						input_tokens: 1200,
						input_tokens_details: {
							cached_tokens: 300,
						},
						output_tokens: 90,
						total_tokens: 1290,
					},
				},
			},
		]);
		const usageEvent = events.find(
			(e): e is Extract<ParsedStreamEvent, { kind: "usage" }> =>
				e.kind === "usage",
		);
		expect(usageEvent).toBeDefined();
		if (usageEvent === undefined) {
			throw new Error("expected usage event");
		}

		const calc = new CostCalculator({
			pricing: loadBundledPricing(),
			warn: () => {},
		});
		const cost = calc.priceUsage(usageEvent.model, usageEvent.usage);
		expect(cost.inputUsd).toBeCloseTo((900 / 1_000_000) * 1.75);
		expect(cost.cacheReadUsd).toBeCloseTo((300 / 1_000_000) * 0.175);
		expect(cost.outputUsd).toBeCloseTo((90 / 1_000_000) * 14);
		expect(cost.totalUsd).toBeCloseTo(
			(900 / 1_000_000) * 1.75 +
				(300 / 1_000_000) * 0.175 +
				(90 / 1_000_000) * 14,
		);
	});

	it("sanitizes malformed token counts before emitting usage", async () => {
		const events = await pumpFixture([
			{
				type: "result",
				model: "claude-opus-4-7",
				usage: {
					input_tokens: 12.9,
					output_tokens: -3,
					cache_creation_input_tokens: Number.NaN,
					cache_read_input_tokens: 4.1,
				},
			},
		]);

		const usageEvents = events.filter(
			(e): e is Extract<ParsedStreamEvent, { kind: "usage" }> =>
				e.kind === "usage",
		);
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]?.usage).toEqual({
			inputTokens: 12,
			outputTokens: 0,
			cacheCreateTokens: 0,
			cacheReadTokens: 4,
		});
	});

	it("drops non-JSON lines (status noise) without throwing", async () => {
		const stdout = new PassThrough();
		const collected: ParsedStreamEvent[] = [];
		const reader = (async () => {
			for await (const event of streamAgentEvents(stdout)) {
				collected.push(event);
			}
		})();
		stdout.write("not json\n");
		stdout.write("[bin] starting\n");
		stdout.write(
			`${JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "ok" }] },
			})}\n`,
		);
		stdout.end();
		await reader;
		expect(collected.map((e) => e.kind)).toEqual(["text"]);
	});
});
