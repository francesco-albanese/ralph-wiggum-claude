import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { claude, codex } from "../providers.js";
import {
	buildQualityGateAgentCommand,
	spawnQualityGateAgent,
} from "./agent.js";

type FakeChild = ChildProcess & { stdout: PassThrough };

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	Object.assign(child, {
		stdout: new PassThrough(),
		kill: vi.fn(() => true),
	});
	return child;
}

describe("buildQualityGateAgentCommand", () => {
	it("passes the QG prompt through the active Claude provider", () => {
		const command = buildQualityGateAgentCommand(claude("sonnet"), "PROMPT");

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
				"PROMPT",
			],
			env: {},
		});
	});

	it("passes the QG prompt through the active Codex provider", () => {
		const command = buildQualityGateAgentCommand(
			codex("gpt-5.3-codex"),
			"PROMPT",
		);

		expect(command).toEqual({
			cmd: "codex",
			args: [
				"exec",
				"--json",
				"--dangerously-bypass-approvals-and-sandbox",
				"-m",
				"gpt-5.3-codex",
				"PROMPT",
			],
			env: {},
		});
	});
});

describe("spawnQualityGateAgent", () => {
	it("streams provider output and collects Claude text", async () => {
		const child = fakeChild();
		const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
		const out = new PassThrough();
		const output: string[] = [];
		out.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));

		const result = spawnQualityGateAgent({
			cwd: "/repo",
			prompt: "/quality-gate\ncontext",
			provider: claude("sonnet"),
			spawnImpl,
			out,
		});

		child.stdout?.write(
			`${JSON.stringify({
				type: "assistant",
				message: {
					content: [{ type: "text", text: "<ralph-qg>{}</ralph-qg>" }],
				},
			})}\n`,
		);
		child.stdout?.end();
		child.emit("close", 0, null);

		await expect(result).resolves.toBe("<ralph-qg>{}</ralph-qg>");
		expect(output.join("")).toBe("<ralph-qg>{}</ralph-qg>");
		expect(spawnImpl).toHaveBeenCalledWith(
			"claude",
			expect.arrayContaining(["/quality-gate\ncontext"]),
			expect.objectContaining({ cwd: "/repo" }),
		);
	});

	it("streams provider output and collects Codex text", async () => {
		const child = fakeChild();
		const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;

		const result = spawnQualityGateAgent({
			cwd: "/repo",
			prompt: "$quality-gate\ncontext",
			provider: codex("gpt-5.3-codex"),
			spawnImpl,
			out: new PassThrough(),
		});

		child.stdout?.write(
			`${JSON.stringify({
				type: "response.output_text.delta",
				delta: "<ralph-qg>{}</ralph-qg>",
			})}\n`,
		);
		child.stdout?.end();
		child.emit("close", 0, null);

		await expect(result).resolves.toBe("<ralph-qg>{}</ralph-qg>");
		expect(spawnImpl).toHaveBeenCalledWith(
			"codex",
			expect.arrayContaining(["$quality-gate\ncontext"]),
			expect.any(Object),
		);
	});

	it("rejects on non-zero exit", async () => {
		const child = fakeChild();
		const result = spawnQualityGateAgent({
			cwd: "/repo",
			prompt: "PROMPT",
			provider: claude("sonnet"),
			spawnImpl: vi.fn(() => child) as unknown as typeof spawn,
			out: new PassThrough(),
		});

		child.stdout?.end();
		child.emit("close", 2, null);

		await expect(result).rejects.toThrow(/exited with code 2/);
	});

	it("rejects on timeout and SIGTERMs the child", async () => {
		vi.useFakeTimers();
		try {
			const child = fakeChild();
			const result = spawnQualityGateAgent({
				cwd: "/repo",
				prompt: "PROMPT",
				provider: claude("sonnet"),
				spawnImpl: vi.fn(() => child) as unknown as typeof spawn,
				timeoutMs: 10,
				hardKillGraceMs: 10,
				out: new PassThrough(),
			});

			vi.advanceTimersByTime(11);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			child.stdout?.end();
			child.emit("close", 143, null);

			await expect(result).rejects.toThrow(/timed out/);
		} finally {
			vi.useRealTimers();
		}
	});
});
