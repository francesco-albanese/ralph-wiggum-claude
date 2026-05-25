import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CostCalculator, loadBundledPricing } from "../cost.js";
import { type AgentProvider, codex } from "../providers.js";
import type { ParsedStreamEvent } from "../stream.js";
import { streamAgentEvents } from "../stream.js";

async function pumpFixture(
	lines: readonly unknown[],
	provider?: AgentProvider,
): Promise<ParsedStreamEvent[]> {
	const stdout = new PassThrough();
	const collected: ParsedStreamEvent[] = [];
	const reader = (async () => {
		for await (const event of streamAgentEvents(stdout, provider)) {
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

describe("streamAgentEvents — OpenAI Responses usage", () => {
	it("normalizes OpenAI Responses usage from response.completed", async () => {
		const events = await pumpFixture(
			[
				{
					type: "response.created",
					response: { model: "gpt-5.3-codex", usage: null },
				},
				{
					type: "response.completed",
					response: {
						model: "gpt-5.3-codex",
						usage: {
							input_tokens: 1200,
							input_tokens_details: { cached_tokens: 300 },
							output_tokens: 90,
							output_tokens_details: { reasoning_tokens: 12 },
							total_tokens: 1290,
						},
					},
				},
			],
			codex("gpt-5.3-codex"),
		);

		const resultEvents = events.filter(
			(e): e is Extract<ParsedStreamEvent, { kind: "result" }> =>
				e.kind === "result",
		);
		expect(resultEvents).toHaveLength(1);
		expect(resultEvents[0]?.model).toBe("gpt-5.3-codex");
		expect(resultEvents[0]?.usage).toEqual({
			inputTokens: 900,
			outputTokens: 90,
			cacheCreateTokens: 0,
			cacheReadTokens: 300,
		});
	});

	it("tolerates OpenAI Responses usage without cached-token details", async () => {
		const events = await pumpFixture(
			[
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
			],
			codex("gpt-5.5"),
		);

		const resultEvents = events.filter(
			(e): e is Extract<ParsedStreamEvent, { kind: "result" }> =>
				e.kind === "result",
		);
		expect(resultEvents).toHaveLength(1);
		expect(resultEvents[0]?.usage).toEqual({
			inputTokens: 1200,
			outputTokens: 90,
			cacheCreateTokens: 0,
			cacheReadTokens: 0,
		});
	});

	it("feeds OpenAI cached input into cost calculation without double-billing", async () => {
		const events = await pumpFixture(
			[
				{
					type: "response.completed",
					response: {
						model: "gpt-5.3-codex",
						usage: {
							input_tokens: 1200,
							input_tokens_details: { cached_tokens: 300 },
							output_tokens: 90,
							total_tokens: 1290,
						},
					},
				},
			],
			codex("gpt-5.3-codex"),
		);
		const resultEvent = events.find(
			(e): e is Extract<ParsedStreamEvent, { kind: "result" }> =>
				e.kind === "result",
		);
		expect(resultEvent).toBeDefined();
		if (resultEvent === undefined) {
			throw new Error("expected result event");
		}

		const calc = new CostCalculator({
			pricing: loadBundledPricing(),
			warn: () => {},
		});
		const cost = calc.priceUsage(resultEvent.model, resultEvent.usage);
		expect(cost.inputUsd).toBeCloseTo((900 / 1_000_000) * 1.75);
		expect(cost.cacheReadUsd).toBeCloseTo((300 / 1_000_000) * 0.175);
		expect(cost.outputUsd).toBeCloseTo((90 / 1_000_000) * 14);
		expect(cost.totalUsd).toBeCloseTo(
			(900 / 1_000_000) * 1.75 +
				(300 / 1_000_000) * 0.175 +
				(90 / 1_000_000) * 14,
		);
	});
});
