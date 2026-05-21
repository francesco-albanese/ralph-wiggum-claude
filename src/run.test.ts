import { describe, expect, it, vi } from "vitest";
import type { IterationResult } from "./iteration.js";
import { type Orchestrator, orchestrate } from "./run.js";

function makeOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
	return {
		captureBaseBranch: vi.fn(async () => "main"),
		ensureCleanWorktree: vi.fn(async () => {}),
		checkoutBranch: vi.fn(async (_b: string) => {}),
		commitsAhead: vi.fn(async (_b: string) => 1),
		pushBranch: vi.fn(async (_b: string) => {}),
		createDraftPr: vi.fn(async () => "https://github.com/x/y/pull/1"),
		markPrReady: vi.fn(async (_url: string) => {}),
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

	it("refuses to open a PR when no iteration produced commits", async () => {
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

	it("rejects --branch matching the captured base branch", async () => {
		const orch = makeOrchestrator({
			captureBaseBranch: vi.fn(async () => "feat/foo"),
		});

		await expect(
			orchestrate(orch, { branch: "feat/foo", maxIter: 2 }),
		).rejects.toThrow(/matches the current branch/i);
	});
});
