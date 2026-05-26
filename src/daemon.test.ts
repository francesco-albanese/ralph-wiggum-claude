import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { followFile, selectRun } from "./daemon.js";
import type { RunState } from "./state.js";

const ZERO_TOKENS = {
	inputTokens: 0,
	outputTokens: 0,
	cacheCreateTokens: 0,
	cacheReadTokens: 0,
};

function state(pid: number, startedAt: string): RunState {
	return {
		pid,
		branch: "feat/x",
		agent: "claude",
		model: "sonnet",
		startedAt,
		iteration: 1,
		currentBead: null,
		tasksDone: [],
		tokens: ZERO_TOKENS,
		costUsd: 0,
		logPath: `/tmp/${pid}.log`,
		prUrl: "",
	};
}

describe("selectRun", () => {
	const runs = [
		state(1, "2026-05-25T10:00:00.000Z"),
		state(2, "2026-05-25T11:00:00.000Z"),
	];

	it("selects an explicit pid", () => {
		expect(selectRun(runs, 1).pid).toBe(1);
	});

	it("errors when stop has multiple active runs and no pid", () => {
		expect(() => selectRun(runs)).toThrow(/multiple active/i);
	});

	it("lets tail pick the most recent run when no pid is provided", () => {
		expect(selectRun(runs, undefined, true).pid).toBe(2);
	});

	it("streams appended log content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ralph-tail-"));
		const path = join(dir, "run.log");
		try {
			writeFileSync(path, "first\n");
			const out = new PassThrough();
			const chunks: string[] = [];
			out.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
			const ac = new AbortController();

			const tailing = followFile(path, out, ac.signal);
			await new Promise((resolve) => setTimeout(resolve, 10));
			writeFileSync(path, "first\nsecond\n");
			await new Promise((resolve) => setTimeout(resolve, 30));
			ac.abort();
			await tailing;

			expect(chunks.join("")).toContain("first\n");
			expect(chunks.join("")).toContain("second\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
