import { describe, expect, it } from "vitest";
import type { CostBreakdown } from "../cost.js";
import type { IterationUsage } from "../stream.js";
import { buildWhatsAppNotification, notifyTerminalState } from "./notify.js";
import type { OrchestrationResult } from "./orchestrate.js";

const USAGE: IterationUsage = {
	inputTokens: 100,
	outputTokens: 50,
	cacheCreateTokens: 0,
	cacheReadTokens: 0,
};

const COST: CostBreakdown = {
	inputUsd: 0,
	outputUsd: 0,
	cacheCreateUsd: 0,
	cacheReadUsd: 0,
	totalUsd: 0.01,
};

const COMPLETE: OrchestrationResult = {
	outcome: "complete",
	prUrl: "https://github.com/o/r/pull/1",
	iterations: 2,
	crashes: 0,
	qualityGate: {
		prTitle: "feat: notify",
		prBody: "One. Two.",
		followUpBeadIds: [],
		autoFixCommitted: false,
	},
};

function notification(result: OrchestrationResult) {
	return buildWhatsAppNotification({
		repoRoot: "/tmp/ralph-wiggum-claude",
		branch: "feat/notify",
		maxIter: 5,
		wallMs: 65_000,
		result,
		totalUsage: USAGE,
		totalCost: COST,
	});
}

describe("buildWhatsAppNotification", () => {
	it("maps COMPLETE state to a done task and QG summary", () => {
		const msg = notification(COMPLETE);

		expect(msg.status).toBe("complete");
		expect(msg.tasksDone).toBe(1);
		expect(msg.done).toEqual(["feat: notify"]);
		expect(msg.qgFindings).toBe("QG: no follow-ups");
	});

	it("maps stalled state to warning metadata", () => {
		const msg = notification({
			outcome: "stalled",
			prUrl: "https://github.com/o/r/pull/1",
			iterations: 5,
			crashes: 0,
			stallReason: "max-iter",
		});

		expect(msg.status).toBe("stalled");
		expect(msg.tasksBlocked).toBe(1);
		expect(msg.stallReason).toBe("max-iter");
		expect(msg.qgFindings).toBe("QG: skipped");
	});

	it("does not leak raw QG errors to WhatsApp", () => {
		const msg = notification({
			...COMPLETE,
			qualityGate: undefined,
			qgError: "stderr contained SECRET_TOKEN=abc123",
		});

		expect(msg.qgFindings).toBe("QG: failed - see PR/logs");
		expect(msg.qgFindings).not.toContain("SECRET_TOKEN");
	});
});

describe("notifyTerminalState", () => {
	it("does not throw when config loading fails", async () => {
		await expect(
			notifyTerminalState({
				repoRoot: "/path/that/does/not/exist",
				branch: "feat/notify",
				maxIter: 5,
				wallMs: 1,
				result: COMPLETE,
				totalUsage: USAGE,
				totalCost: COST,
			}),
		).resolves.toBeUndefined();
	});
});
