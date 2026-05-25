import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type LogEvent, nowIso, openLog } from "./log.js";

function freshRepoRoot(): string {
	return mkdtempSync(join(tmpdir(), "ralph-log-"));
}

const fixedNow = () => new Date("2026-05-25T14:30:42.123Z");

describe("openLog / StructuredLog", () => {
	it("writes one JSON object per line to .ralph/logs/<timestamp>-<pid>.log", async () => {
		const root = freshRepoRoot();
		const log = openLog(root, { now: fixedNow, pid: 4242 });

		const events: LogEvent[] = [
			{
				event: "invocation_start",
				ts: nowIso(fixedNow),
				pid: 4242,
				branch: "feat/test",
				maxIter: 3,
			},
			{ event: "iteration_start", ts: nowIso(fixedNow), iteration: 1 },
			{
				event: "stream",
				ts: nowIso(fixedNow),
				iteration: 1,
				payload: { kind: "text", text: "hi" },
			},
			{
				event: "iteration_end",
				ts: nowIso(fixedNow),
				iteration: 1,
				outcome: "complete",
				exitCode: 0,
				taskClosed: true,
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cacheCreateTokens: 0,
					cacheReadTokens: 0,
				},
				cost: {
					inputUsd: 0,
					outputUsd: 0,
					cacheCreateUsd: 0,
					cacheReadUsd: 0,
					totalUsd: 0,
				},
				model: "claude-opus-4-7",
			},
		];

		for (const event of events) log.write(event);
		await log.close();

		// File exists in the expected location.
		const dir = join(root, ".ralph/logs");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const filename = files[0];
		// Colon-free, includes pid.
		expect(filename).toMatch(/^2026-05-25T14-30-42Z-4242\.log$/);
		expect(log.path).toBe(join(dir, filename ?? ""));

		// One JSON object per line, every line parseable.
		const lines = readFileSync(log.path, "utf8")
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(events.length);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}

		// Last line round-trips to the iteration_end event.
		const last = JSON.parse(lines[lines.length - 1] ?? "{}") as LogEvent;
		expect(last.event).toBe("iteration_end");
		if (last.event === "iteration_end") {
			expect(last.usage.inputTokens).toBe(10);
			expect(last.cost.totalUsd).toBe(0);
			expect(last.model).toBe("claude-opus-4-7");
		}
	});

	it("creates the .ralph/logs directory if it does not exist", async () => {
		const root = freshRepoRoot();
		// Nothing under root yet.
		const log = openLog(root, { now: fixedNow, pid: 1 });
		log.write({
			event: "invocation_start",
			ts: nowIso(fixedNow),
			pid: 1,
		});
		await log.close();
		// Directory must exist; readdir would throw if it didn't.
		expect(() => readdirSync(join(root, ".ralph/logs"))).not.toThrow();
	});
});
