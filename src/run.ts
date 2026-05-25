import { parseBranch } from "./branch.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import type { AgentName } from "./config/schema.js";
import { addUsage, EMPTY_USAGE } from "./cost.js";
import { runIteration } from "./iteration.js";
import { createAgentProvider } from "./providers.js";
import {
	createDefaultQualityGatePorts,
	type QualityGateReport,
	runQualityGate,
} from "./quality-gate.js";
import { pricedRunIteration, wireDisplay } from "./run/display.js";
import { notifyTerminalState } from "./run/notify.js";
import {
	type OrchestrationResult,
	type Orchestrator,
	orchestrate,
} from "./run/orchestrate.js";
import {
	captureRepoRoot,
	defaultCommitsAhead,
	defaultCreateDraftPr,
	defaultMarkPrReady,
	defaultPushBranch,
	hostCaptureBaseBranch,
	hostEnsureCleanWorktree,
	installGracefulShutdown,
	runInWorktree,
	spawnAgent,
} from "./run/runtime.js";

export interface RunOptions {
	readonly branch: string;
	readonly agent?: AgentName;
	readonly model?: string;
	readonly maxIter?: number;
	readonly timeoutMin?: number;
	readonly completeSignal?: RegExp;
}

const DEFAULT_MAX_ITER = 10;
const DEFAULT_TIMEOUT_MIN = 30;

export type RunCommandResult = {
	readonly outcome: "complete" | "stalled" | "interrupted";
	readonly prUrl: string;
	readonly iterations: number;
	readonly crashes: number;
	readonly stallReason?: "max-iter" | "crash-rate";
	readonly qualityGate?: QualityGateReport;
	readonly qgError?: string;
};

export { pricedRunIteration, wireDisplay } from "./run/display.js";
export {
	type OrchestrationOptions,
	type OrchestrationResult,
	type Orchestrator,
	orchestrate,
} from "./run/orchestrate.js";
export {
	type AgentContext,
	type AgentRunner,
	captureRepoRoot,
	defaultCommitsAhead,
	defaultCreateDraftPr,
	defaultMarkPrReady,
	defaultPushBranch,
	type GracefulShutdown,
	type GracefulShutdownOptions,
	hostCaptureBaseBranch,
	hostEnsureCleanWorktree,
	installGracefulShutdown,
	runInWorktree,
	spawnAgent,
} from "./run/runtime.js";

export async function runCommand(opts: RunOptions): Promise<RunCommandResult> {
	const startedAt = Date.now();
	parseBranch(opts.branch);

	const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
	const timeoutMin = opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
	const timeoutMs = timeoutMin * 60_000;
	const provider = createAgentProvider(
		opts.agent ?? DEFAULT_CONFIG.defaultAgent,
		opts.model ?? DEFAULT_CONFIG.defaultModel,
	);

	const baseBranch = await hostCaptureBaseBranch();
	await hostEnsureCleanWorktree();

	let orchResult: OrchestrationResult | undefined;
	const repoRoot = await captureRepoRoot();
	const {
		log: structuredLog,
		cost,
		display,
	} = wireDisplay({
		repoRoot,
		...(opts.completeSignal !== undefined
			? { completeSignal: opts.completeSignal }
			: {}),
		provider,
	});
	let totalUsage = EMPTY_USAGE;
	let shutdownDispose: (() => void) | null = null;
	try {
		structuredLog.write({
			event: "invocation_start",
			ts: new Date().toISOString(),
			pid: process.pid,
			branch: opts.branch,
			maxIter,
		});

		const shutdown = installGracefulShutdown();
		shutdownDispose = shutdown.dispose;
		await runInWorktree({
			branch: opts.branch,
			repoRoot,
			signal: shutdown.signal,
			forceSignal: shutdown.forceSignal,
			agent: async ({ cwd, signal, forceSignal }) => {
				const wrappedRunIteration = pricedRunIteration({
					display,
					log: structuredLog,
					cost,
					maxIter,
					spawnRunIteration: (consume) =>
						runIteration({
							spawn: () => spawnAgent({ cwd, signal, forceSignal, provider }),
							out: process.stdout,
							timeoutMs,
							consume,
							...(opts.completeSignal !== undefined
								? { completeSignal: opts.completeSignal }
								: {}),
							provider,
						}),
					onIterationDone: (_iteration, result) => {
						totalUsage = addUsage(totalUsage, result.usage);
					},
				});

				const orch: Orchestrator = {
					captureBaseBranch: async () => baseBranch,
					ensureCleanWorktree: async () => {},
					checkoutBranch: async (_branch: string) => {},
					commitsAhead: (base) => defaultCommitsAhead(cwd, base),
					pushBranch: (branch) => defaultPushBranch(cwd, branch),
					createDraftPr: (args) => defaultCreateDraftPr(cwd, args),
					markPrReady: (url) => defaultMarkPrReady(cwd, url),
					runQualityGate: (input) =>
						runQualityGate(
							createDefaultQualityGatePorts({ cwd, repoRoot, provider }),
							{ ...input, cwd },
						),
					runIteration: wrappedRunIteration,
				};

				orchResult = await orchestrate(orch, {
					branch: opts.branch,
					maxIter,
				});
			},
		});
	} finally {
		shutdownDispose?.();
		const outcome = orchResult?.outcome ?? "interrupted";
		display.renderFinalSummary({
			iterations: orchResult?.iterations ?? 0,
			maxIter,
			outcome,
			totalUsage,
			...(orchResult?.stallReason !== undefined
				? { stallReason: orchResult.stallReason }
				: {}),
		});
		if (
			orchResult?.outcome === "complete" ||
			orchResult?.outcome === "stalled"
		) {
			await notifyTerminalState({
				repoRoot,
				branch: opts.branch,
				maxIter,
				wallMs: Date.now() - startedAt,
				result: orchResult,
				totalUsage,
				totalCost: cost.total(),
			});
		}
		await structuredLog.close();
	}

	if (orchResult === undefined) {
		return {
			outcome: "interrupted",
			prUrl: "",
			iterations: 0,
			crashes: 0,
		};
	}
	return orchResult;
}
