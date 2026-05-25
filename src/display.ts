import type { Readable, Writable } from "node:stream";
import { log } from "@clack/prompts";
import {
	type CostBreakdown,
	type CostCalculator,
	EMPTY_USAGE,
} from "./cost.js";
import {
	defaultDim,
	formatToolLine,
	redactStreamEvent,
	zeroCost,
} from "./display/format.js";
import type { IterationResult } from "./iteration.js";
import type { StructuredLog } from "./log.js";
import type { AgentProvider } from "./providers.js";
import {
	type IterationUsage,
	type ParsedStreamEvent,
	streamAgentEvents,
} from "./stream.js";
import {
	type FinalSummary,
	type IterationSummary,
	renderFinalSummary,
	renderIterationSummary,
} from "./summary.js";

export { formatToolLine } from "./display/format.js";

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
	readonly provider?: AgentProvider;
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
	private readonly provider: AgentProvider | undefined;
	private accumulatedText = "";

	constructor(opts: StreamDisplayOptions) {
		this.cost = opts.cost;
		this.slog = opts.log;
		this.out = opts.out ?? process.stdout;
		this.toolArgMax = opts.toolArgMaxChars ?? DEFAULT_TOOL_ARG_MAX;
		this.dim = opts.dim ?? defaultDim;
		this.completeSignal = opts.completeSignal ?? DEFAULT_COMPLETE_SIGNAL;
		this.provider = opts.provider;
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

		for await (const event of streamAgentEvents(stdout, this.provider)) {
			this.slog.write({
				event: "stream",
				ts: new Date().toISOString(),
				iteration,
				payload: redactStreamEvent(event),
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
			case "session_id":
				if (event.model !== undefined) {
					log.info(`agent ready (model: ${event.model})`, { output: this.out });
				}
				return;
			case "text":
				// Dim streamed prose so the per-iteration summary box
				// stands out at the boundary. Write directly (not via
				// clack's `log`) — we want raw streaming, not a step
				// symbol per chunk.
				this.out.write(this.dim(event.text));
				return;
			case "tool_call":
				log.step(formatToolLine(event.name, event.input, this.toolArgMax), {
					output: this.out,
				});
				return;
			case "result":
				// Don't render usage events directly — they roll up
				// into the iteration-summary box.
				return;
		}
	}

	private fold(acc: IterationAccumulator, event: ParsedStreamEvent): void {
		switch (event.kind) {
			case "session_id":
				if (event.model !== undefined) acc.model = event.model;
				return;
			case "text": {
				// Accumulate a small text buffer so multi-chunk
				// completion signals are still detected. Cap to a
				// generous tail to bound memory.
				this.accumulatedText = (this.accumulatedText + event.text).slice(
					-4_096,
				);
				this.completeSignal.lastIndex = 0;
				if (this.completeSignal.test(this.accumulatedText)) {
					acc.taskClosed = true;
				}
				return;
			}
			case "tool_call":
				return;
			case "result": {
				// `stream.ts` only surfaces usage from the terminal
				// `result` event, so we expect a single usage event per
				// iteration. Using last-writer-wins (not additive) keeps
				// the math correct even if a future agent provider
				// emits multiple snapshots.
				acc.usage = event.usage;
				if (event.model !== undefined) acc.model = event.model;
				acc.cost = this.cost.priceUsage(event.model ?? acc.model, event.usage);
				return;
			}
		}
	}

	/** Render the per-iteration summary box. */
	renderIterationSummary(args: {
		iteration: number;
		maxIter: number;
		acc: IterationAccumulator;
		result: IterationResult;
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
		this.recordIterationEnd({
			iteration: args.iteration,
			result: args.result,
			acc: args.acc,
		});
	}

	/** Persist the iteration boundary even when there was nothing to render. */
	recordIterationEnd(args: {
		iteration: number;
		result: IterationResult;
		acc: IterationAccumulator;
	}): void {
		this.slog.write({
			event: "iteration_end",
			ts: new Date().toISOString(),
			iteration: args.iteration,
			outcome: args.result.outcome,
			exitCode: args.result.exitCode,
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
