import { describe, expect, it, vi } from "vitest";
import type { IterationResult } from "./iteration.js";
import { type Orchestrator, orchestrate } from "./run.js";

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

describe("orchestrate", () => {
	it("opens a draft PR after the first iteration that produces commits and marks it ready when the agent emits the completion signal", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => ({
				outcome: "complete",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 3,
		});

		expect(orch.checkoutBranch).toHaveBeenCalledWith("feat/foo");
		expect(orch.pushBranch).toHaveBeenCalledWith("feat/foo");
		expect(orch.createDraftPr).toHaveBeenCalledWith({
			base: "main",
			head: "feat/foo",
		});
		expect(orch.markPrReady).toHaveBeenCalledWith(
			"https://github.com/x/y/pull/1",
		);
		expect(result).toMatchObject({
			outcome: "complete",
			prUrl: "https://github.com/x/y/pull/1",
		});
	});

	it("leaves the PR draft when the invocation stalls at max-iter", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => ({
				outcome: "continue",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 2,
		});

		expect(orch.markPrReady).not.toHaveBeenCalled();
		expect(result.outcome).toBe("stalled");
		expect(result.prUrl).toBe("https://github.com/x/y/pull/1");
	});

	it("opens the draft PR after iteration 1 (before iteration 2 starts)", async () => {
		// Long/stalled runs must surface work to humans early. The draft
		// PR must exist by the time the second iteration begins so a
		// reviewer can see progress without waiting for the loop to exit.
		const callOrder: string[] = [];
		const orch = makeOrchestrator({
			pushBranch: vi.fn(async (_b: string) => {
				callOrder.push("pushBranch");
			}),
			createDraftPr: vi.fn(async () => {
				callOrder.push("createDraftPr");
				return "https://github.com/x/y/pull/1";
			}),
			runIteration: vi.fn(async (iteration: number) => {
				callOrder.push(`runIteration#${iteration}`);
				return { outcome: "continue", exitCode: 0 } as IterationResult;
			}),
		});

		await orchestrate(orch, { branch: "feat/foo", maxIter: 2 });

		expect(callOrder).toEqual([
			"runIteration#1",
			"pushBranch",
			"createDraftPr",
			"runIteration#2",
		]);
		// And the PR is created exactly once, even though both iterations
		// produce commits.
		expect(orch.pushBranch).toHaveBeenCalledTimes(1);
		expect(orch.createDraftPr).toHaveBeenCalledTimes(1);
	});

	it("does not open a PR until an iteration actually produces commits", async () => {
		// Iteration 1 produces 0 commits (agent only inspected); iteration
		// 2 finally commits something. The PR should open then, not after
		// iteration 1.
		let iterations = 0;
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => {
				iterations += 1;
				return { outcome: "continue", exitCode: 0 } as IterationResult;
			}),
			// 0 commits on the first poll, 1 on the second.
			commitsAhead: vi
				.fn<(b: string) => Promise<number>>()
				.mockResolvedValueOnce(0)
				.mockResolvedValueOnce(1),
		});

		await orchestrate(orch, { branch: "feat/foo", maxIter: 2 });

		expect(iterations).toBe(2);
		expect(orch.createDraftPr).toHaveBeenCalledTimes(1);
		expect(orch.commitsAhead).toHaveBeenCalledTimes(2);
	});

	it("refuses to open a PR when a STALLED invocation produced no commits", async () => {
		const orch = makeOrchestrator({
			commitsAhead: vi.fn(async () => 0),
			runIteration: vi.fn(async () => ({
				outcome: "continue",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
		});

		await expect(
			orchestrate(orch, { branch: "feat/foo", maxIter: 2 }),
		).rejects.toThrow(/no commits/i);

		expect(orch.createDraftPr).not.toHaveBeenCalled();
		expect(orch.markPrReady).not.toHaveBeenCalled();
	});

	it("treats COMPLETE + no commits as a no-op success (empty prUrl, no PR opened)", async () => {
		// Agent legitimately completed (e.g. inspected the repo, decided
		// nothing needed doing, emitted the sentinel). Not a failure —
		// we should not throw, and we should not open an empty PR.
		const orch = makeOrchestrator({
			commitsAhead: vi.fn(async () => 0),
			runIteration: vi.fn(async () => ({
				outcome: "complete",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 2,
		});

		expect(result.outcome).toBe("complete");
		expect(result.prUrl).toBe("");
		expect(orch.pushBranch).not.toHaveBeenCalled();
		expect(orch.createDraftPr).not.toHaveBeenCalled();
		expect(orch.markPrReady).not.toHaveBeenCalled();
	});

	it("leaves the PR draft when an iteration is interrupted mid-flight", async () => {
		// Ctrl-C must NOT trigger markPrReady — the iteration was killed
		// by signal, the work is incomplete, and the PR should stay draft
		// so a reviewer sees it as "in progress, came back later".
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => ({
				outcome: "signal-killed",
				exitCode: null,
			})) as Orchestrator["runIteration"],
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 5,
		});

		expect(orch.markPrReady).not.toHaveBeenCalled();
		expect(result.outcome).toBe("interrupted");
		expect(result.prUrl).toBe("https://github.com/x/y/pull/1");
	});

	it("returns empty prUrl when interrupted before any iteration produced commits", async () => {
		// Ctrl-C on iteration 1 with no commits yet: no PR was opened,
		// and orchestrate must not throw the "no commits" error that
		// only applies to stalled runs.
		const orch = makeOrchestrator({
			commitsAhead: vi.fn(async () => 0),
			runIteration: vi.fn(async () => ({
				outcome: "signal-killed",
				exitCode: null,
			})) as Orchestrator["runIteration"],
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 5,
		});

		expect(result.outcome).toBe("interrupted");
		expect(result.prUrl).toBe("");
		expect(orch.createDraftPr).not.toHaveBeenCalled();
		expect(orch.markPrReady).not.toHaveBeenCalled();
	});

	it("rejects --branch matching the captured base branch", async () => {
		const orch = makeOrchestrator({
			captureBaseBranch: vi.fn(async () => "feat/foo"),
		});

		await expect(
			orchestrate(orch, { branch: "feat/foo", maxIter: 2 }),
		).rejects.toThrow(/matches the current branch/i);
	});

	it("runs the quality gate exactly once at COMPLETE, then marks the PR ready", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => ({
				outcome: "complete",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
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
			runIteration: vi.fn(async () => ({
				outcome: "continue",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
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
			runIteration: vi.fn(async () => ({
				outcome: "signal-killed",
				exitCode: null,
			})) as Orchestrator["runIteration"],
		});

		await orchestrate(orch, { branch: "feat/foo", maxIter: 5 });

		expect(orch.runQualityGate).not.toHaveBeenCalled();
		expect(orch.markPrReady).not.toHaveBeenCalled();
	});

	it("leaves the PR draft and records qgError when the quality gate throws", async () => {
		const orch = makeOrchestrator({
			runIteration: vi.fn(async () => ({
				outcome: "complete",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
			runQualityGate: vi.fn(async () => {
				throw new Error("agent crashed");
			}),
		});

		const result = await orchestrate(orch, {
			branch: "feat/foo",
			maxIter: 3,
		});

		expect(orch.runQualityGate).toHaveBeenCalledTimes(1);
		// QG failure must NOT mark PR ready — leaves it draft for review.
		expect(orch.markPrReady).not.toHaveBeenCalled();
		expect(result.outcome).toBe("complete");
		expect(result.qgError).toMatch(/agent crashed/);
		expect(result.qualityGate).toBeUndefined();
	});

	it("skips the quality gate when COMPLETE produced no commits (no PR to edit)", async () => {
		const orch = makeOrchestrator({
			commitsAhead: vi.fn(async () => 0),
			runIteration: vi.fn(async () => ({
				outcome: "complete",
				exitCode: 0,
			})) as Orchestrator["runIteration"],
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
