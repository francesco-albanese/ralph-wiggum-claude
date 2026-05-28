import { describe, expect, it } from "vitest";
import {
	addUsage,
	CostCalculator,
	loadBundledPricing,
	type PricingTable,
} from "./cost.js";
import type { IterationUsage } from "./stream.js";

const FIXTURE_PRICING: PricingTable = {
	version: "test-2026-05-25",
	currency: "USD",
	unit: "per_million_tokens",
	models: {
		"test-model": {
			agent: "claude",
			input: 10,
			output: 100,
			cacheCreate: 12.5,
			cacheRead: 1,
		},
	},
};

const usage = (overrides: Partial<IterationUsage> = {}): IterationUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheCreateTokens: 0,
	cacheReadTokens: 0,
	...overrides,
});

describe("CostCalculator", () => {
	it("converts per-token usage into USD using the per-million rates", () => {
		const calc = new CostCalculator({
			pricing: FIXTURE_PRICING,
			warn: () => {},
		});
		// 1M input @ $10 + 500k output @ $100 = $10 + $50 = $60.
		// 200k cache-create @ $12.5 = $2.5; 1M cache-read @ $1 = $1.
		const breakdown = calc.priceUsage(
			"test-model",
			usage({
				inputTokens: 1_000_000,
				outputTokens: 500_000,
				cacheCreateTokens: 200_000,
				cacheReadTokens: 1_000_000,
			}),
		);
		expect(breakdown.inputUsd).toBeCloseTo(10);
		expect(breakdown.outputUsd).toBeCloseTo(50);
		expect(breakdown.cacheCreateUsd).toBeCloseTo(2.5);
		expect(breakdown.cacheReadUsd).toBeCloseTo(1);
		expect(breakdown.totalUsd).toBeCloseTo(63.5);
	});

	it("accumulates across calls into total()", () => {
		const calc = new CostCalculator({
			pricing: FIXTURE_PRICING,
			warn: () => {},
		});
		calc.priceUsage("test-model", usage({ inputTokens: 1_000_000 }));
		calc.priceUsage("test-model", usage({ outputTokens: 1_000_000 }));
		expect(calc.total().totalUsd).toBeCloseTo(110);
	});

	it("falls back to zero cost AND warns once when the model is unknown", () => {
		const warnings: string[] = [];
		const calc = new CostCalculator({
			pricing: FIXTURE_PRICING,
			warn: (m) => warnings.push(m),
		});

		const a = calc.priceUsage(
			"some-unreleased-model",
			usage({ inputTokens: 999_999 }),
		);
		const b = calc.priceUsage(
			"some-unreleased-model",
			usage({ outputTokens: 999_999 }),
		);

		expect(a.totalUsd).toBe(0);
		expect(b.totalUsd).toBe(0);
		expect(calc.total().totalUsd).toBe(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/some-unreleased-model/);
		expect(warnings[0]).toMatch(/\$0\.00/);
	});

	it("falls back to zero cost when no model is supplied (and does not warn)", () => {
		const warnings: string[] = [];
		const calc = new CostCalculator({
			pricing: FIXTURE_PRICING,
			warn: (m) => warnings.push(m),
		});

		const b = calc.priceUsage(undefined, usage({ inputTokens: 1_000_000 }));
		expect(b.totalUsd).toBe(0);
		// No model id to name in a warning, so we stay quiet.
		expect(warnings).toEqual([]);
	});

	it("exposes the pricing version for the structured log", () => {
		const calc = new CostCalculator({
			pricing: FIXTURE_PRICING,
			warn: () => {},
		});
		expect(calc.pricingVersion()).toBe("test-2026-05-25");
	});
});

describe("addUsage", () => {
	it("sums every token field", () => {
		expect(
			addUsage(
				usage({
					inputTokens: 100,
					outputTokens: 50,
					cacheCreateTokens: 10,
					cacheReadTokens: 5,
				}),
				usage({
					inputTokens: 7,
					outputTokens: 3,
					cacheCreateTokens: 2,
					cacheReadTokens: 1,
				}),
			),
		).toEqual({
			inputTokens: 107,
			outputTokens: 53,
			cacheCreateTokens: 12,
			cacheReadTokens: 6,
		});
	});
});

describe("bundled pricing JSON", () => {
	it("ships in-package, is versioned, and lists known models", () => {
		// `loadBundledPricing` reads from `src/pricing/pricing.json`
		// next to this test (vitest runs from src/). Smoke-tests that
		// the file is present, parses, and carries the required shape.
		const pricing = loadBundledPricing();
		expect(typeof pricing.version).toBe("string");
		expect(pricing.version.length).toBeGreaterThan(0);
		expect(pricing.currency).toBe("USD");
		expect(pricing.unit).toBe("per_million_tokens");
		// At least one model must exist so the production path
		// doesn't degenerate to "every model is unknown".
		expect(Object.keys(pricing.models).length).toBeGreaterThan(0);
	});

	it("prices current Codex/OpenAI models from bundled rates", () => {
		const warnings: string[] = [];
		const calc = new CostCalculator({
			warn: (m) => warnings.push(m),
		});

		const codex = calc.priceUsage(
			"gpt-5.3-codex",
			usage({
				inputTokens: 900_000,
				outputTokens: 1_000_000,
				cacheReadTokens: 100_000,
			}),
		);
		expect(codex.inputUsd).toBeCloseTo(1.575);
		expect(codex.outputUsd).toBeCloseTo(14);
		expect(codex.cacheCreateUsd).toBe(0);
		expect(codex.cacheReadUsd).toBeCloseTo(0.0175);
		expect(codex.totalUsd).toBeCloseTo(15.5925);

		const gpt55 = calc.priceUsage(
			"gpt-5.5",
			usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
		);
		expect(gpt55.totalUsd).toBeCloseTo(35);
		expect(warnings).toEqual([]);
	});
});
