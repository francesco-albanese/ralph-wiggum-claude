import type { Writable } from "node:stream";
import { box } from "@clack/prompts";
import type { CostBreakdown } from "./cost.js";
import type { IterationUsage } from "./stream.js";

/**
 * State the per-iteration summary box needs. Pure data — caller
 * (`StreamDisplay`) is responsible for building it as iterations
 * complete; this module owns only the rendering.
 */
export type IterationSummary = {
	readonly iteration: number;
	readonly maxIter: number;
	/**
	 * Whether the agent emitted the completion signal this iteration.
	 * Mirrors the "task closed" semantic in the bead acceptance
	 * criteria — the iteration closed its work.
	 */
	readonly taskClosed: boolean;
	readonly usage: IterationUsage;
	readonly cost: CostBreakdown;
	/** Model the agent reported, if any (for "unknown" cost diagnosis). */
	readonly model?: string;
};

/** Cumulative-totals summary printed at the end of the invocation. */
export type FinalSummary = {
	readonly iterations: number;
	readonly maxIter: number;
	readonly outcome: "complete" | "stalled" | "interrupted";
	readonly stallReason?: "max-iter" | "crash-rate";
	readonly totalUsage: IterationUsage;
	readonly totalCost: CostBreakdown;
};

/**
 * Render the per-iteration summary box between iterations. Title
 * encodes iteration progress; body is a small KV block of token /
 * cost lines so reviewers can spot a runaway iteration at a glance.
 */
export function renderIterationSummary(
	summary: IterationSummary,
	output: Writable = process.stdout,
): void {
	const title = `iteration ${summary.iteration}/${summary.maxIter}${
		summary.taskClosed ? " — task closed" : ""
	}`;
	box(formatIterationBody(summary), title, { output });
}

/**
 * Render the cumulative summary box at invocation exit. Always
 * printed (complete / stalled / interrupted) so the user has a
 * single source of truth on how much the run cost.
 */
export function renderFinalSummary(
	summary: FinalSummary,
	output: Writable = process.stdout,
): void {
	const title = `ralph: ${summary.outcome}${
		summary.stallReason !== undefined ? ` (${summary.stallReason})` : ""
	}`;
	box(formatFinalBody(summary), title, { output });
}

function formatIterationBody(s: IterationSummary): string {
	const lines = [
		`tokens   in ${fmtTokens(s.usage.inputTokens)}  out ${fmtTokens(
			s.usage.outputTokens,
		)}`,
		`cache    create ${fmtTokens(s.usage.cacheCreateTokens)}  read ${fmtTokens(
			s.usage.cacheReadTokens,
		)}`,
		`cost     ${fmtUsd(s.cost.totalUsd)}`,
	];
	if (s.model !== undefined) lines.push(`model    ${s.model}`);
	return lines.join("\n");
}

function formatFinalBody(s: FinalSummary): string {
	return [
		`iterations  ${s.iterations}/${s.maxIter}`,
		`tokens      in ${fmtTokens(s.totalUsage.inputTokens)}  out ${fmtTokens(
			s.totalUsage.outputTokens,
		)}`,
		`cache       create ${fmtTokens(
			s.totalUsage.cacheCreateTokens,
		)}  read ${fmtTokens(s.totalUsage.cacheReadTokens)}`,
		`cost        ${fmtUsd(s.totalCost.totalUsd)}`,
	].join("\n");
}

/** Compact token formatter — `1.2k`, `345`, `1.5M`. */
export function fmtTokens(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** USD formatter — always 4 decimal places so $0.0042 doesn't read as $0. */
export function fmtUsd(n: number): string {
	return `$${n.toFixed(4)}`;
}
