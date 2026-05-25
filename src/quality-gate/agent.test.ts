import { describe, expect, it } from "vitest";
import { claude, codex } from "../providers.js";
import { buildQualityGateAgentCommand } from "./agent.js";

describe("buildQualityGateAgentCommand", () => {
	it("uses the active Claude provider command path", () => {
		const command = buildQualityGateAgentCommand(claude("sonnet"));

		expect(command).toEqual({
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
		});
	});

	it("uses the active Codex provider command path", () => {
		const command = buildQualityGateAgentCommand(codex("gpt-5.3-codex"));

		expect(command).toEqual({
			cmd: "codex",
			args: [
				"exec",
				"--json",
				"--dangerously-bypass-approvals-and-sandbox",
				"-m",
				"gpt-5.3-codex",
			],
		});
	});

	it("does not embed the provider quality gate command as an argv value", () => {
		const command = buildQualityGateAgentCommand(codex("gpt-5.3-codex"));

		expect(command.args).not.toContain("$quality-gate");
		expect(command.args).not.toContain("<ralph-qg>");
	});
});
