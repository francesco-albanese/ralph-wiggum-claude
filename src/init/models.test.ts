import { describe, expect, it } from "vitest";
import type { PricingTable } from "../cost.js";
import {
	CUSTOM_MODEL_VALUE,
	defaultModelForAgent,
	modelOptionsForAgent,
} from "./models.js";

const rate = { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 };

const PRICING: PricingTable = {
	version: "test",
	currency: "USD",
	unit: "per_million_tokens",
	models: {
		"claude-sonnet-4-5": { agent: "claude", ...rate },
		"claude-opus-4-7": { agent: "claude", ...rate },
		"gpt-5.3-codex": { agent: "codex", ...rate },
		"gpt-5.5": { agent: "codex", ...rate },
	},
};

describe("modelOptionsForAgent", () => {
	it("returns only claude models for the claude agent, in table order", () => {
		const opts = modelOptionsForAgent("claude", PRICING);
		expect(opts.slice(0, -1).map((o) => o.value)).toEqual([
			"claude-sonnet-4-5",
			"claude-opus-4-7",
		]);
	});

	it("returns only codex models for the codex agent", () => {
		const opts = modelOptionsForAgent("codex", PRICING);
		expect(opts.slice(0, -1).map((o) => o.value)).toEqual([
			"gpt-5.3-codex",
			"gpt-5.5",
		]);
	});

	it("never mixes agents — codex models never appear for claude", () => {
		const claudeValues = modelOptionsForAgent("claude", PRICING).map(
			(o) => o.value,
		);
		expect(claudeValues).not.toContain("gpt-5.3-codex");
		expect(claudeValues).not.toContain("gpt-5.5");
	});

	it("always appends a Custom escape hatch as the last option", () => {
		for (const agent of ["claude", "codex"] as const) {
			const opts = modelOptionsForAgent(agent, PRICING);
			const last = opts[opts.length - 1];
			expect(last).toEqual({ value: CUSTOM_MODEL_VALUE, label: "Custom…" });
		}
	});

	it("offers Custom even when no model is priced for the agent", () => {
		const empty: PricingTable = { ...PRICING, models: {} };
		const opts = modelOptionsForAgent("claude", empty);
		expect(opts).toEqual([{ value: CUSTOM_MODEL_VALUE, label: "Custom…" }]);
	});
});

describe("defaultModelForAgent", () => {
	it("defaults to the first table model of the agent", () => {
		expect(defaultModelForAgent("claude", PRICING)).toBe("claude-sonnet-4-5");
		expect(defaultModelForAgent("codex", PRICING)).toBe("gpt-5.3-codex");
	});

	it("falls back to the Custom sentinel when no model is priced", () => {
		const empty: PricingTable = { ...PRICING, models: {} };
		expect(defaultModelForAgent("claude", empty)).toBe(CUSTOM_MODEL_VALUE);
	});
});
