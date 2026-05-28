import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentName } from "./config/schema.js";
import type { IterationUsage } from "./stream.js";

/**
 * Per-token-type rates for a single model, expressed in USD per
 * million tokens — matches industry pricing pages so the JSON is
 * auditable against the source.
 *
 * `agent` ties the model to the CLI that can run it. It is the single
 * source of truth for the `ralph init` model picker: adding a model
 * here both prices it and surfaces it in the picker, so there is no
 * second list to maintain.
 */
export type ModelPricing = {
	readonly agent: AgentName;
	readonly input: number;
	readonly output: number;
	readonly cacheCreate: number;
	readonly cacheRead: number;
};

/**
 * Shape of the bundled pricing JSON. `version` is a date stamp;
 * refreshes ship via package version bumps so a given Ralph release
 * always uses one known pricing snapshot.
 */
export type PricingTable = {
	readonly version: string;
	readonly currency: string;
	/** Pricing unit — always "per_million_tokens" in v1. */
	readonly unit: "per_million_tokens";
	readonly models: Readonly<Record<string, ModelPricing>>;
};

/**
 * USD cost breakdown for one usage event. Surfaced separately
 * (input/output/cache) so the summary box and structured log can
 * show where the money actually went, not just the total.
 */
export type CostBreakdown = {
	readonly inputUsd: number;
	readonly outputUsd: number;
	readonly cacheCreateUsd: number;
	readonly cacheReadUsd: number;
	readonly totalUsd: number;
};

/**
 * Calculator-side hooks for IO and warnings. Defaulted to real
 * filesystem + stderr; tests inject in-memory tables and capture
 * warnings without touching the package's bundled JSON.
 */
export type CostCalculatorOptions = {
	/**
	 * Override the bundled pricing table. Production reads
	 * `src/pricing/pricing.json` next to this module; tests pass
	 * a fixture.
	 */
	readonly pricing?: PricingTable;
	/**
	 * Sink for unknown-model warnings. Defaults to `process.stderr`.
	 * One warning per unknown model id per CostCalculator instance —
	 * we never repeat the same warning, otherwise a long run would
	 * spam the terminal once per iteration.
	 */
	readonly warn?: (msg: string) => void;
};

const ZERO: CostBreakdown = {
	inputUsd: 0,
	outputUsd: 0,
	cacheCreateUsd: 0,
	cacheReadUsd: 0,
	totalUsd: 0,
};

/**
 * Pricing JSON path. Resolved relative to THIS module so it works in
 * both `dist/` (after `tsc`) and `src/` (test runs via vitest). We
 * `fs.readFile` it instead of `import ... with { type: "json" }`
 * because `tsc` does not copy JSON assets into `dist/` by default
 * and we want the file to ship in the package without a custom build
 * step.
 */
const PRICING_JSON_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"pricing",
	"pricing.json",
);

let cachedDefaultPricing: PricingTable | undefined;

export function loadBundledPricing(): PricingTable {
	if (cachedDefaultPricing !== undefined) return cachedDefaultPricing;
	const raw = readFileSync(PRICING_JSON_PATH, "utf8");
	const parsed = JSON.parse(raw) as PricingTable;
	cachedDefaultPricing = parsed;
	return parsed;
}

/**
 * Stateful per-invocation cost tracker. Owns the model -> rates
 * lookup, the unknown-model warning bookkeeping, and the running
 * totals used by the final summary box.
 *
 * Use `priceUsage(model, usage)` to convert one usage event to a
 * `CostBreakdown` (also accumulated into `total()`).
 */
export class CostCalculator {
	private readonly pricing: PricingTable;
	private readonly warn: (msg: string) => void;
	private readonly warnedModels: Set<string> = new Set();
	private running: CostBreakdown = ZERO;

	constructor(opts: CostCalculatorOptions = {}) {
		this.pricing = opts.pricing ?? loadBundledPricing();
		this.warn = opts.warn ?? ((msg) => process.stderr.write(`${msg}\n`));
	}

	/** Pricing table version (date stamp). */
	pricingVersion(): string {
		return this.pricing.version;
	}

	/**
	 * Convert one usage event into a USD breakdown. Adds it to the
	 * running totals. Unknown models -> zero cost + a one-shot warning.
	 */
	priceUsage(model: string | undefined, usage: IterationUsage): CostBreakdown {
		const rates = model !== undefined ? this.pricing.models[model] : undefined;
		if (rates === undefined) {
			if (model !== undefined && !this.warnedModels.has(model)) {
				this.warnedModels.add(model);
				this.warn(
					`ralph: unknown model "${model}" — cost reported as $0.00 (update pricing.json)`,
				);
			}
			// Still accumulate zeros so the running total stays consistent.
			this.running = add(this.running, ZERO);
			return ZERO;
		}

		const inputUsd = perMillion(usage.inputTokens, rates.input);
		const outputUsd = perMillion(usage.outputTokens, rates.output);
		const cacheCreateUsd = perMillion(
			usage.cacheCreateTokens,
			rates.cacheCreate,
		);
		const cacheReadUsd = perMillion(usage.cacheReadTokens, rates.cacheRead);
		const breakdown: CostBreakdown = {
			inputUsd,
			outputUsd,
			cacheCreateUsd,
			cacheReadUsd,
			totalUsd: inputUsd + outputUsd + cacheCreateUsd + cacheReadUsd,
		};
		this.running = add(this.running, breakdown);
		return breakdown;
	}

	/** Cumulative USD totals across every `priceUsage` call. */
	total(): CostBreakdown {
		return this.running;
	}
}

function perMillion(tokens: number, ratePerMillion: number): number {
	return (tokens / 1_000_000) * ratePerMillion;
}

function add(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
	return {
		inputUsd: a.inputUsd + b.inputUsd,
		outputUsd: a.outputUsd + b.outputUsd,
		cacheCreateUsd: a.cacheCreateUsd + b.cacheCreateUsd,
		cacheReadUsd: a.cacheReadUsd + b.cacheReadUsd,
		totalUsd: a.totalUsd + b.totalUsd,
	};
}

/** Sum two iteration-usage totals. Surface helper for callers. */
export function addUsage(a: IterationUsage, b: IterationUsage): IterationUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheCreateTokens: a.cacheCreateTokens + b.cacheCreateTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
	};
}

/** Zero-valued usage event for accumulator seeds. */
export const EMPTY_USAGE: IterationUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheCreateTokens: 0,
	cacheReadTokens: 0,
};
