import type { Readable, Writable } from "node:stream";
import { log } from "@clack/prompts";
import {
	type CostBreakdown,
	type CostCalculator,
	EMPTY_USAGE,
	addUsage,
} from "./cost.js";
import type { StructuredLog } from "./log.js";
import {
	type FinalSummary,
	type IterationSummary,
	renderFinalSummary,
	renderIterationSummary,
} from "./summary.js";
import {
	type IterationUsage,
	type ParsedStreamEvent,
	streamAgentEvents,
} from "./stream.js";

/**
 * Per-iteration aggregation built up by `StreamDisplay` as
 * stream events arrive. Snapshotted into `IterationSummary` at
 * the iteration boundary so cost + tokens reflect THIS iteration
 * only (the cumulative roll-up lives in `CostCalculator`).
 */
export type IterationAccumulator = {
	usage: IterationUsage;
	cost: CostBreakdown;
	model?: string;
	taskClosed: boolean;
};

export type StreamDisplayOptions = {
	readonly cost: CostCalculator;
	readonly log: StructuredLog;
	readonly out?: Writable;
	/** Max chars to keep when rendering a tool's arguments. */
	readonly toolArgMaxChars?: number;
	/**
	 * Override the dim wrapper for prose. Defaults to ANSI dim
	 * (`\x1b[2m...\x1b[22m`) — kept tiny so we don't need a colour lib.
	 */
	readonly dim?: (text: string) => string;
	/**
	 * Override the completion-signal detector. Defaults to the
	 * canonical `<promise>COMPLETE</promise>` sentinel so the
	 * "task closed" flag in the per-iteration summary is correct
	 * without coupling to `iteration.ts` internals.
	 */
	readonly completeSignal?: RegExp;
};

const DEFAULT_TOOL_ARG_MAX = 80;
const DEFAULT_COMPLETE_SIGNAL = /<promise>COMPLETE<\/promise>/;

/**
 * Terminal renderer for `ParsedStreamEvent`s + bookkeeper for the
 * structured log + per-iteration cost roll-up.
 *
 * One instance per invocation. Call `consume(stdout, iteration)`
 * for each agent subprocess; it drains the stream, prints prose
 * dimmed, prints tool calls as one-line entries, accumulates usage
 * via the injected `CostCalculator`, and resolves with the
 * per-iteration accumulator the caller passes to
 * `renderIterationSummary`.
 */
export class StreamDisplay {
	private readonly cost: CostCalculator;
	private readonly slog: StructuredLog;
	private readonly out: Writable;
	private readonly toolArgMax: number;
	private readonly dim: (text: string) => string;
	private readonly completeSignal: RegExp;
	private accumulatedText = "";

	constructor(opts: StreamDisplayOptions) {
		this.cost = opts.cost;
		this.slog = opts.log;
		this.out = opts.out ?? process.stdout;
		this.toolArgMax = opts.toolArgMaxChars ?? DEFAULT_TOOL_ARG_MAX;
		this.dim = opts.dim ?? defaultDim;
		this.completeSignal = opts.completeSignal ?? DEFAULT_COMPLETE_SIGNAL;
	}

	/**
	 * Drive one iteration's stream to the terminal + log + cost
	 * roll-up. Returns the per-iteration accumulator so the caller
	 * can render the iteration-summary box.
	 *
	 * Each `ParsedStreamEvent` is also persisted to the log,
	 * one JSON object per line.
	 */
	async consume(
		stdout: Readable,
		iteration: number,
	): Promise<IterationAccumulator> {
		const acc: IterationAccumulator = {
			usage: EMPTY_USAGE,
			cost: zeroCost(),
			taskClosed: false,
		};
		this.accumulatedText = "";

		for await (const event of streamAgentEvents(stdout)) {
			this.slog.write({
				event: "stream",
				ts: new Date().toISOString(),
				iteration,
				payload: event,
			});
			this.render(event);
			this.fold(acc, event);
		}

		// Final tick after the stream drains so the bottom of an
		// iteration's prose has a newline before the summary box.
		this.out.write("\n");
		return acc;
	}

	private render(event: ParsedStreamEvent): void {
		switch (event.kind) {
			case "init":
				log.info(`agent ready (model: ${event.model})`, { output: this.out });
				return;
			case "text":
				// Dim streamed prose so the per-iteration summary box
				// stands out at the boundary. Write directly (not via
				// clack's `log`) — we want raw streaming, not a step
				// symbol per chunk.
				this.out.write(this.dim(event.text));
				return;
			case "tool":
				log.step(formatToolLine(event.name, event.input, this.toolArgMax), {
					output: this.out,
				});
				return;
			case "usage":
				// Don't render usage events directly — they roll up
				// into the iteration-summary box.
				return;
		}
	}

	private fold(acc: IterationAccumulator, event: ParsedStreamEvent): void {
		switch (event.kind) {
			case "init":
				acc.model = event.model;
				return;
			case "text": {
				// Accumulate a small text buffer so multi-chunk
				// completion signals are still detected. Cap to a
				// generous tail to bound memory.
				this.accumulatedText = (this.accumulatedText + event.text).slice(
					-4_096,
				);
				if (this.completeSignal.test(this.accumulatedText)) {
					acc.taskClosed = true;
				}
				return;
			}
			case "tool":
				return;
			case "usage": {
				acc.usage = addUsage(acc.usage, event.usage);
				if (event.model !== undefined && acc.model === undefined) {
					acc.model = event.model;
				}
				const breakdown = this.cost.priceUsage(
					event.model ?? acc.model,
					event.usage,
				);
				acc.cost = addCost(acc.cost, breakdown);
				return;
			}
		}
	}

	/** Render the per-iteration summary box. */
	renderIterationSummary(args: {
		iteration: number;
		maxIter: number;
		acc: IterationAccumulator;
	}): void {
		const summary: IterationSummary = {
			iteration: args.iteration,
			maxIter: args.maxIter,
			taskClosed: args.acc.taskClosed,
			usage: args.acc.usage,
			cost: args.acc.cost,
			...(args.acc.model !== undefined ? { model: args.acc.model } : {}),
		};
		renderIterationSummary(summary, this.out);
		this.slog.write({
			event: "iteration_end",
			ts: new Date().toISOString(),
			iteration: args.iteration,
			outcome: "rendered",
			exitCode: null,
			taskClosed: args.acc.taskClosed,
			usage: args.acc.usage,
			cost: args.acc.cost,
			...(args.acc.model !== undefined ? { model: args.acc.model } : {}),
		});
	}

	/** Render the cumulative summary box at invocation exit. */
	renderFinalSummary(args: {
		iterations: number;
		maxIter: number;
		outcome: FinalSummary["outcome"];
		totalUsage: IterationUsage;
		stallReason?: "max-iter" | "crash-rate";
	}): void {
		const totalCost = this.cost.total();
		const summary: FinalSummary = {
			iterations: args.iterations,
			maxIter: args.maxIter,
			outcome: args.outcome,
			totalUsage: args.totalUsage,
			totalCost,
			...(args.stallReason !== undefined
				? { stallReason: args.stallReason }
				: {}),
		};
		renderFinalSummary(summary, this.out);
		this.slog.write({
			event: "invocation_end",
			ts: new Date().toISOString(),
			outcome: args.outcome,
			iterations: args.iterations,
			totalUsage: args.totalUsage,
			totalCost,
		});
	}
}

function defaultDim(text: string): string {
	// ANSI 2 = dim. Avoid pulling in a colour lib for one escape.
	return `\x1b[2m${text}\x1b[22m`;
}

export function formatToolLine(
	name: string,
	input: unknown,
	maxArgChars: number,
): string {
	const args = formatToolArgs(input, maxArgChars);
	return args.length > 0 ? `${name}: ${args}` : name;
}

function formatToolArgs(input: unknown, maxChars: number): string {
	if (input === undefined || input === null) return "";
	if (typeof input === "string") return truncate(input, maxChars);
	if (typeof input !== "object") return truncate(String(input), maxChars);

	const rec = input as Record<string, unknown>;
	// Bash/Read/Edit all use `command`/`file_path`/`path` as the
	// salient arg. Pick the first one present so the one-line entry
	// reads like `Bash: bd ready --json` and not a JSON blob.
	for (const key of [
		"command",
		"cmd",
		"file_path",
		"filePath",
		"path",
		"pattern",
		"query",
		"url",
	]) {
		const v = rec[key];
		if (typeof v === "string") return truncate(v, maxChars);
	}
	const json = JSON.stringify(input);
	return truncate(json, maxChars);
}

function truncate(s: string, max: number): string {
	const collapsed = s.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

function zeroCost(): CostBreakdown {
	return {
		inputUsd: 0,
		outputUsd: 0,
		cacheCreateUsd: 0,
		cacheReadUsd: 0,
		totalUsd: 0,
	};
}

function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
	return {
		inputUsd: a.inputUsd + b.inputUsd,
		outputUsd: a.outputUsd + b.outputUsd,
		cacheCreateUsd: a.cacheCreateUsd + b.cacheCreateUsd,
		cacheReadUsd: a.cacheReadUsd + b.cacheReadUsd,
		totalUsd: a.totalUsd + b.totalUsd,
	};
}
