import type { Readable } from "node:stream";
import { CostCalculator } from "../cost.js";
import { type IterationAccumulator, StreamDisplay } from "../display.js";
import type {
	IterationResult,
	IterationStreamSummary,
	RunIterationOptions,
} from "../iteration.js";
import { openLog, type StructuredLog } from "../log.js";
import type { AgentProvider } from "../providers.js";

export type DisplayStack = {
	readonly log: StructuredLog;
	readonly cost: CostCalculator;
	readonly display: StreamDisplay;
};

export function wireDisplay(args: {
	readonly repoRoot: string;
	readonly completeSignal?: RegExp;
	readonly provider?: AgentProvider;
	readonly logPath?: string;
}): DisplayStack {
	const log = openLog(args.repoRoot, {
		...(args.logPath !== undefined ? { path: args.logPath } : {}),
	});
	const cost = new CostCalculator();
	const display = new StreamDisplay({
		cost,
		log,
		...(args.completeSignal !== undefined
			? { completeSignal: args.completeSignal }
			: {}),
		...(args.provider !== undefined ? { provider: args.provider } : {}),
	});
	return { log, cost, display };
}

export function pricedRunIteration(args: {
	readonly display: StreamDisplay;
	readonly log: StructuredLog;
	readonly cost: CostCalculator;
	readonly maxIter: number;
	readonly spawnRunIteration: (
		consume: NonNullable<RunIterationOptions["consume"]>,
		iteration: number,
	) => Promise<IterationResult>;
	readonly onIterationDone: (
		iteration: number,
		result: IterationResult,
		acc: IterationAccumulator,
	) => void;
}): (iteration: number) => Promise<IterationResult> {
	return async (iteration: number): Promise<IterationResult> => {
		args.log.write({
			event: "iteration_start",
			ts: new Date().toISOString(),
			iteration,
		});

		let acc: IterationAccumulator | undefined;
		const consume = async (
			stdout: Readable,
		): Promise<IterationStreamSummary> => {
			acc = await args.display.consume(stdout, iteration);
			return acc.model !== undefined
				? { usage: acc.usage, taskClosed: acc.taskClosed, model: acc.model }
				: { usage: acc.usage, taskClosed: acc.taskClosed };
		};

		const result = await args.spawnRunIteration(consume, iteration);
		const endAcc =
			acc ??
			(result.model !== undefined
				? {
						usage: result.usage,
						cost: args.cost.priceUsage(result.model, result.usage),
						model: result.model,
						taskClosed: result.outcome === "complete",
					}
				: {
						usage: result.usage,
						cost: zeroCost(),
						taskClosed: result.outcome === "complete",
					});

		if (acc !== undefined) {
			args.display.renderIterationSummary({
				iteration,
				maxIter: args.maxIter,
				acc,
				result,
			});
		} else {
			args.display.recordIterationEnd({ iteration, result, acc: endAcc });
		}
		args.onIterationDone(iteration, result, endAcc);
		return result;
	};
}

function zeroCost() {
	return {
		inputUsd: 0,
		outputUsd: 0,
		cacheCreateUsd: 0,
		cacheReadUsd: 0,
		totalUsd: 0,
	};
}
