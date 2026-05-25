import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type AgentProvider, claude, codex } from "../providers.js";
import type { ParsedStreamEvent } from "../stream.js";

const FIXTURE_DIR = fileURLToPath(
	new URL("../../tests/fixtures/", import.meta.url),
);

function fixtureLines(name: string): string[] {
	return readFileSync(join(FIXTURE_DIR, name), "utf8")
		.split(/\r?\n/u)
		.filter((line) => line.length > 0);
}

function parseFixture(
	provider: AgentProvider,
	name: string,
): ParsedStreamEvent[] {
	return fixtureLines(name).flatMap((line) => provider.parseStreamLine(line));
}

describe("AgentProvider command contracts", () => {
	it("builds the Claude print command", () => {
		const provider = claude("sonnet");
		expect(provider.qualityGateCommand).toBe("/quality-gate");
		expect(provider.buildPrintCommand()).toEqual({
			cmd: "claude",
			args: [
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
				"--model",
				"sonnet",
			],
			env: {},
		});
	});

	it("builds the Codex print command", () => {
		const provider = codex("gpt-5.3-codex");
		expect(provider.qualityGateCommand).toBe("$quality-gate");
		expect(provider.buildPrintCommand()).toEqual({
			cmd: "codex",
			args: [
				"exec",
				"--json",
				"--dangerously-bypass-approvals-and-sandbox",
				"-m",
				"gpt-5.3-codex",
			],
			env: {},
		});
	});
});

describe.each([
	{
		label: "claude",
		provider: claude("claude-sonnet-4-5"),
		completeFixture: "claude-stream.jsonl",
		partialFixture: "claude-partial-stream.jsonl",
		model: "claude-sonnet-4-5",
		expectedUsage: {
			inputTokens: 1200,
			outputTokens: 80,
			cacheCreateTokens: 200,
			cacheReadTokens: 300,
		},
	},
	{
		label: "codex",
		provider: codex("gpt-5.3-codex"),
		completeFixture: "codex-stream.jsonl",
		partialFixture: "codex-partial-stream.jsonl",
		model: "gpt-5.3-codex",
		expectedUsage: {
			inputTokens: 900,
			outputTokens: 80,
			cacheCreateTokens: 0,
			cacheReadTokens: 300,
		},
	},
])("$label provider stream contract", (c) => {
	it("normalizes captured stream fixtures and skips malformed JSON", () => {
		const events = parseFixture(c.provider, c.completeFixture);
		const kinds = events.map((event) => event.kind);

		expect(kinds).toContain("session_id");
		expect(kinds).toContain("text");
		expect(kinds).toContain("tool_call");
		expect(kinds).toContain("result");
		expect(events).not.toContainEqual(undefined);

		const result = events.find(
			(event): event is Extract<ParsedStreamEvent, { kind: "result" }> =>
				event.kind === "result",
		);
		expect(result?.model).toBe(c.model);
		expect(result?.usage).toEqual(c.expectedUsage);
	});

	it("handles partial streams without completion result", () => {
		const events = parseFixture(c.provider, c.partialFixture);

		expect(events.some((event) => event.kind === "text")).toBe(true);
		expect(events.some((event) => event.kind === "result")).toBe(false);
	});
});
