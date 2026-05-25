import { describe, expect, it, vi } from "vitest";
import type { IterationOutcome, IterationResult } from "../iteration.js";
import { type Orchestrator, orchestrate } from "../run.js";

const ZERO_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheCreateTokens: 0,
	cacheReadTokens: 0,
};

function iterResult(
	outcome: IterationOutcome,
	exitCode: number | null,
): IterationResult {
	return { outcome, exitCode, usage: ZERO_USAGE };
}

const DEFAULT_QG_REPORT = {
	prTitle: "feat: stub",
	prBody: "stub body",
	followUpBeadIds: [],
	autoFixCommitted: false,
} as const;

function makeOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
	return {
		captureBaseBranch: vi.fn(async () => "main"),
		ensureCleanWorktree: vi.fn(async () => {}),
		checkoutBranch: vi.fn(async (_b: string) => {}),
		commitsAhead: vi.fn(async (_b: string) => 1),
		pushBranch: vi.fn(async (_b: string) => {}),
		createDraftPr: vi.fn(async () => "https://github.com/x/y/pull/1"),
		markPrReady: vi.fn(async (_url: string) => {}),
		runQualityGate: vi.fn(async (_input) => DEFAULT_QG_REPORT),
		runIteration: vi.fn<() => Promise<IterationResult>>(),
		...overrides,
	};
}

describe("orchestrate — quality gate", () => {
	it("runs the quality gate exactly once at COMPLETE, then marks the PR ready", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => iterResult("complete", 0)),
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 3,
		});

		expect(orch.runQualityGate).toHaveBeenCalledTimes(1);
		expect(orch.runQualityGate).toHaveBeenCalledWith({
			branch: "feat/foo",
			baseBranch: "main",
			prUrl: "https://github.com/x/y/pull/1",
		});
		expect(orch.markPrReady).toHaveBeenCalledTimes(1);
		expect(result.qualityGate).toEqual(DEFAULT_QG_REPORT);
		expect(result.qgError).toBeUndefined();
	});

	it("does NOT run the quality gate when the invocation stalls", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => iterResult("continue", 0)),
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 2,
		});

		expect(orch.runQualityGate).not.toHaveBeenCalled();
		expect(orch.markPrReady).not.toHaveBeenCalled();
		expect(result.outcome).toBe("stalled");
		expect(result.qualityGate).toBeUndefined();
	});

	it("does NOT run the quality gate when interrupted", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => iterResult("signal-killed", null)),
		});

		await orchestrate(orch, { branch: "feat/foo", maxIter: 5 });

		expect(orch.runQualityGate).not.toHaveBeenCalled();
		expect(orch.markPrReady).not.toHaveBeenCalled();
	});

	it("leaves the PR draft and records qgError when the quality gate throws", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => iterResult("complete", 0)),
			runQualityGate: vi.fn(async () => {
				throw new Error("agent crashed");
			}),
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 3,
		});

		expect(orch.runQualityGate).toHaveBeenCalledTimes(1);
		expect(orch.markPrReady).not.toHaveBeenCalled();
		expect(result.outcome).toBe("complete");
		expect(result.qgError).toMatch(/agent crashed/);
		expect(result.qualityGate).toBeUndefined();
	});

	it("skips the quality gate when COMPLETE produced no commits", async () => {
		const orch = makeOrchestrator({
			commitsAhead: vi.fn(async () => 0),
			runIteration: vi.fn(async () => iterResult("complete", 0)),
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 2,
		});

		expect(orch.runQualityGate).not.toHaveBeenCalled();
		expect(result.outcome).toBe("complete");
		expect(result.prUrl).toBe("");
	});
});
