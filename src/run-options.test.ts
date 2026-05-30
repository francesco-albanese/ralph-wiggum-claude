import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRunFlags, resolveRunOptions } from "./run-options.js";

describe("parseRunFlags", () => {
	it("leaves config-backed fields undefined when no flag is passed", () => {
		const flags = parseRunFlags({ branch: "feat/x" });
		expect(flags.agent).toBeUndefined();
		expect(flags.model).toBeUndefined();
		expect(flags.maxIter).toBeUndefined();
		expect(flags.completeSignal).toBeUndefined();
		expect(flags.timeoutMin).toBeUndefined();
		expect(flags.detach).toBe(false);
	});

	it("parses the values the user explicitly passed", () => {
		const flags = parseRunFlags({
			branch: "feat/x",
			agent: "codex",
			model: "gpt-5.5",
			maxIter: "40",
			timeoutMin: "45",
			completeSignal: "DONE",
			detach: true,
		});
		expect(flags).toMatchObject({
			branch: "feat/x",
			agent: "codex",
			model: "gpt-5.5",
			maxIter: 40,
			timeoutMin: 45,
			completeSignal: "DONE",
			detach: true,
		});
	});

	it("rejects a non-positive --max-iter", () => {
		expect(() => parseRunFlags({ branch: "feat/x", maxIter: "0" })).toThrow(
			/max-iter/i,
		);
		expect(() => parseRunFlags({ branch: "feat/x", maxIter: "abc" })).toThrow(
			/max-iter/i,
		);
	});

	it("rejects a non-positive --timeout-min", () => {
		expect(() => parseRunFlags({ branch: "feat/x", timeoutMin: "-3" })).toThrow(
			/timeout-min/i,
		);
	});

	it("rejects an unsupported --agent", () => {
		expect(() => parseRunFlags({ branch: "feat/x", agent: "qwen" })).toThrow(
			/agent/i,
		);
	});
});

describe("resolveRunOptions", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ralph-run-options-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeConfig(value: unknown): Promise<void> {
		await mkdir(join(dir, ".ralph"), { recursive: true });
		await writeFile(
			join(dir, ".ralph", "ralph.config.json"),
			JSON.stringify(value),
			"utf8",
		);
	}

	it("uses config-file values when no CLI flag is passed (the regression)", async () => {
		await writeConfig({
			defaultAgent: "codex",
			defaultModel: "gpt-5.5",
			maxIter: 40,
		});

		const opts = await resolveRunOptions({
			raw: { branch: "feat/x" },
			cwd: dir,
		});

		expect(opts.agent).toBe("codex");
		expect(opts.model).toBe("gpt-5.5");
		expect(opts.maxIter).toBe(40);
	});

	it("lets a CLI flag override the config file (CLI > file)", async () => {
		await writeConfig({ defaultAgent: "codex", maxIter: 40 });

		const opts = await resolveRunOptions({
			raw: { branch: "feat/x", agent: "claude", maxIter: "7" },
			cwd: dir,
		});

		expect(opts.agent).toBe("claude");
		expect(opts.maxIter).toBe(7);
	});

	it("falls back to defaults when neither flag nor config file supplies a value", async () => {
		const opts = await resolveRunOptions({
			raw: { branch: "feat/x" },
			cwd: dir,
		});

		expect(opts.agent).toBe("claude");
		expect(opts.model).toBe("sonnet");
		expect(opts.maxIter).toBe(10);
		expect(opts.timeoutMin).toBe(30);
	});

	it("compiles the resolved completion signal into a RegExp", async () => {
		const opts = await resolveRunOptions({
			raw: { branch: "feat/x" },
			cwd: dir,
		});
		expect(opts.completeSignal).toBeInstanceOf(RegExp);
		expect(opts.completeSignal?.test("<promise>COMPLETE</promise>")).toBe(true);
	});

	it("lets --complete-signal override the config completion signal", async () => {
		await writeConfig({ completionSignal: "FILE_DONE" });
		const opts = await resolveRunOptions({
			raw: { branch: "feat/x", completeSignal: "CLI_(DONE|OK)" },
			cwd: dir,
		});
		expect(opts.completeSignal?.test("CLI_OK")).toBe(true);
		expect(opts.completeSignal?.test("FILE_DONE")).toBe(false);
	});

	it("throws a clear error when the resolved completion signal is an invalid regex", async () => {
		await expect(
			resolveRunOptions({
				raw: { branch: "feat/x", completeSignal: "[unclosed" },
				cwd: dir,
			}),
		).rejects.toThrow(/completion signal/i);
	});

	it("surfaces a config-file schema error", async () => {
		await writeConfig({ maxIter: -5 });
		await expect(
			resolveRunOptions({ raw: { branch: "feat/x" }, cwd: dir }),
		).rejects.toThrow();
	});

	it("carries the detach flag through", async () => {
		const opts = await resolveRunOptions({
			raw: { branch: "feat/x", detach: true },
			cwd: dir,
		});
		expect(opts.detach).toBe(true);
	});
});
