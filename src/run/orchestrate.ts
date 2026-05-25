import type { IterationResult } from "../iteration.js";
import { runInvocation } from "../loop.js";
import type { QualityGateReport } from "../quality-gate.js";

export interface Orchestrator {
	captureBaseBranch: () => Promise<string>;
	ensureCleanWorktree: () => Promise<void>;
	checkoutBranch: (branch: string) => Promise<void>;
	commitsAhead: (base: string) => Promise<number>;
	pushBranch: (branch: string) => Promise<void>;
	createDraftPr: (args: { base: string; head: string }) => Promise<string>;
	markPrReady: (url: string) => Promise<void>;
	runQualityGate: (input: {
		readonly branch: string;
		readonly baseBranch: string;
		readonly prUrl: string;
	}) => Promise<QualityGateReport>;
	runIteration: (iteration: number) => Promise<IterationResult>;
}

export interface OrchestrationOptions {
	readonly branch: string;
	readonly maxIter: number;
	readonly onIterationEnd?: (
		iteration: number,
		result: IterationResult,
	) => void | Promise<void>;
}

export interface OrchestrationResult {
	readonly outcome: "complete" | "stalled" | "interrupted";
	readonly prUrl: string;
	readonly iterations: number;
	readonly crashes: number;
	readonly stallReason?: "max-iter" | "crash-rate";
	readonly qualityGate?: QualityGateReport;
	readonly qgError?: string;
}

export async function orchestrate(
	orch: Orchestrator,
	opts: OrchestrationOptions,
): Promise<OrchestrationResult> {
	const { branch, maxIter } = opts;

	const baseBranch = await orch.captureBaseBranch();
	if (baseBranch.length === 0) {
		throw new Error("could not determine current branch (detached HEAD?)");
	}
	if (baseBranch === branch) {
		throw new Error(
			`--branch ${branch} matches the current branch; supply a new branch name`,
		);
	}

	await orch.ensureCleanWorktree();
	await orch.checkoutBranch(branch);

	let prUrl: string | undefined;
	const summary = await runInvocation({
		maxIter,
		runIteration: async (iteration) => {
			const result = await orch.runIteration(iteration);
			if (prUrl === undefined) {
				const commits = await orch.commitsAhead(baseBranch);
				if (commits > 0) {
					await orch.pushBranch(branch);
					prUrl = await orch.createDraftPr({ base: baseBranch, head: branch });
				}
			}
			return result;
		},
		...(opts.onIterationEnd !== undefined
			? { onIterationEnd: opts.onIterationEnd }
			: {}),
	});

	if (prUrl === undefined) {
		if (summary.outcome === "complete") {
			return {
				outcome: "complete",
				prUrl: "",
				iterations: summary.iterations,
				crashes: summary.crashes,
			};
		}
		if (summary.outcome === "interrupted") {
			return {
				outcome: "interrupted",
				prUrl: "",
				iterations: summary.iterations,
				crashes: summary.crashes,
			};
		}
		throw new Error(
			`agent produced no commits on ${branch}; refusing to open an empty PR`,
		);
	}

	let qualityGate: QualityGateReport | undefined;
	let qgError: string | undefined;
	if (summary.outcome === "complete") {
		try {
			qualityGate = await orch.runQualityGate({ branch, baseBranch, prUrl });
		} catch (err) {
			qgError = err instanceof Error ? err.message : String(err);
		}
		if (qualityGate !== undefined) {
			await orch.markPrReady(prUrl);
		}
	}

	return {
		outcome: summary.outcome,
		prUrl,
		iterations: summary.iterations,
		crashes: summary.crashes,
		...(summary.stallReason !== undefined
			? { stallReason: summary.stallReason }
			: {}),
		...(qualityGate !== undefined ? { qualityGate } : {}),
		...(qgError !== undefined ? { qgError } : {}),
	};
}
