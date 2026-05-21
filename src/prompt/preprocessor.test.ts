import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultShellRunner,
	loadAndRenderPrompt,
	renderPrompt,
} from "./preprocessor.js";

describe("renderPrompt — substitution", () => {
	it("substitutes the built-in {{BRANCH}} placeholder", async () => {
		const rendered = await renderPrompt("source branch: {{BRANCH}}", {
			branch: "feat/prompt-template",
			targetBranch: "main",
		});

		expect(rendered).toBe("source branch: feat/prompt-template");
	});

	it("substitutes the built-in {{TARGET_BRANCH}} placeholder", async () => {
		const rendered = await renderPrompt(
			"PR target: {{TARGET_BRANCH}}; source: {{BRANCH}}",
			{ branch: "feat/x", targetBranch: "main" },
		);

		expect(rendered).toBe("PR target: main; source: feat/x");
	});

	it("substitutes user-supplied placeholders", async () => {
		const rendered = await renderPrompt("epic={{EPIC_ID}} model={{MODEL}}", {
			branch: "feat/x",
			targetBranch: "main",
			userVars: { EPIC_ID: "ralph-a84", MODEL: "sonnet" },
		});

		expect(rendered).toBe("epic=ralph-a84 model=sonnet");
	});

	it("does not let userVars override the built-in BRANCH / TARGET_BRANCH", async () => {
		const rendered = await renderPrompt("{{BRANCH}} -> {{TARGET_BRANCH}}", {
			branch: "feat/real",
			targetBranch: "main",
			userVars: {
				BRANCH: "attacker-controlled",
				TARGET_BRANCH: "evil",
			},
		});

		expect(rendered).toBe("feat/real -> main");
	});

	it("aborts with a clear error when a placeholder is unmatched", async () => {
		await expect(
			renderPrompt("task is {{TYPO_HERE}} and {{ALSO_MISSING}} in {{BRANCH}}", {
				branch: "feat/x",
				targetBranch: "main",
			}),
		).rejects.toThrow(/unmatched placeholder.*TYPO_HERE.*ALSO_MISSING/s);
	});
});

describe("renderPrompt — shell expressions", () => {
	it("replaces a `!`cmd`` line with the command's stdout", async () => {
		const template = ["# Ready beads", "!`bd ready --limit 5`", "# end"].join(
			"\n",
		);

		const rendered = await renderPrompt(
			template,
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async (cmd) => {
					expect(cmd).toBe("bd ready --limit 5");
					return { stdout: "task-1 ready\ntask-2 ready\n", exitCode: 0 };
				},
			},
		);

		expect(rendered).toBe(
			["# Ready beads", "task-1 ready\ntask-2 ready", "# end"].join("\n"),
		);
	});

	it("substitutes placeholders BEFORE running shell expressions", async () => {
		const seen: string[] = [];
		await renderPrompt(
			"!`git log {{TARGET_BRANCH}}..{{BRANCH}}`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async (cmd) => {
					seen.push(cmd);
					return { stdout: "abc commit", exitCode: 0 };
				},
			},
		);

		expect(seen).toEqual(["git log main..feat/x"]);
	});

	it("expands multiple shell expressions in document order", async () => {
		const template = [
			"## Ready",
			"!`bd ready`",
			"",
			"## Commits",
			"!`git log main..HEAD`",
		].join("\n");

		const calls: string[] = [];
		const rendered = await renderPrompt(
			template,
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async (cmd) => {
					calls.push(cmd);
					if (cmd === "bd ready") return { stdout: "one task", exitCode: 0 };
					if (cmd === "git log main..HEAD")
						return { stdout: "abc one\ndef two", exitCode: 0 };
					throw new Error(`unexpected cmd ${cmd}`);
				},
			},
		);

		expect(calls).toEqual(["bd ready", "git log main..HEAD"]);
		expect(rendered).toBe(
			["## Ready", "one task", "", "## Commits", "abc one\ndef two"].join("\n"),
		);
	});

	it("inlines a visible error marker when a shell command fails (non-zero exit)", async () => {
		const rendered = await renderPrompt(
			"!`false-command`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({
					stdout: "",
					stderr: "command not found",
					exitCode: 127,
				}),
			},
		);

		expect(rendered).toMatch(/\[shell-error/);
		expect(rendered).toContain("false-command");
		expect(rendered).toContain("127");
		expect(rendered).toContain("command not found");
	});

	it("inlines an error marker when the shell runner throws", async () => {
		const rendered = await renderPrompt(
			"!`bd does-not-exist`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => {
					throw new Error("spawn ENOENT");
				},
			},
		);

		expect(rendered).toMatch(/\[shell-error/);
		expect(rendered).toContain("bd does-not-exist");
		expect(rendered).toContain("spawn ENOENT");
	});

	it("truncates shell-expression output at the 4KB cap with a ...(N more) indicator", async () => {
		const bigStdout = "x".repeat(5000);
		const rendered = await renderPrompt(
			"!`bd memories`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: bigStdout, exitCode: 0 }),
			},
		);

		// Default cap is 4096 bytes.
		expect(rendered.length).toBeLessThan(bigStdout.length);
		// Kept bytes <= cap.
		const truncationMarker = rendered.match(
			/\.\.\.\((\d+) more bytes truncated\)/,
		);
		expect(truncationMarker).not.toBeNull();
		const moreBytes = Number.parseInt(truncationMarker?.[1] ?? "0", 10);
		expect(moreBytes).toBe(5000 - 4096);
		// Prefix of the stdout is preserved.
		expect(rendered.startsWith("x".repeat(100))).toBe(true);
	});

	it("respects a custom maxOutputBytes override", async () => {
		const rendered = await renderPrompt(
			"!`bd ready`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: "abcdefghijklmnop", exitCode: 0 }),
				maxOutputBytes: 5,
			},
		);

		expect(rendered).toContain("abcde");
		expect(rendered).toContain("...(11 more bytes truncated)");
		expect(rendered).not.toContain("fghij");
	});

	it("does not append the truncation marker when output fits under the cap", async () => {
		const rendered = await renderPrompt(
			"!`bd ready`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: "tiny", exitCode: 0 }),
				maxOutputBytes: 4096,
			},
		);

		expect(rendered).toBe("tiny");
	});

	it("preserves leading whitespace and re-indents multi-line output", async () => {
		const template = ["text", "  !`git status -s`", "after"].join("\n");

		const rendered = await renderPrompt(
			template,
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: "M file1\nA file2", exitCode: 0 }),
			},
		);

		expect(rendered).toBe(
			["text", "  M file1", "  A file2", "after"].join("\n"),
		);
	});

	it("leaves non-shell-expression backticks alone (e.g. markdown code spans)", async () => {
		const template = "Use the `bd ready` command to start.";

		const rendered = await renderPrompt(
			template,
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => {
					throw new Error("should not be called");
				},
			},
		);

		expect(rendered).toBe(template);
	});
});

describe("loadAndRenderPrompt", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ralph-prompt-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads the file at the given path and renders it", async () => {
		const path = join(dir, "prompt.md");
		await writeFile(path, "Working on {{BRANCH}}\n!`echo hello`\n", "utf8");

		const rendered = await loadAndRenderPrompt(
			path,
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: "hello", exitCode: 0 }),
			},
		);

		expect(rendered).toBe("Working on feat/x\nhello\n");
	});

	it("throws a clear error when the prompt file is missing", async () => {
		const path = join(dir, "does-not-exist.md");

		await expect(
			loadAndRenderPrompt(path, {
				branch: "feat/x",
				targetBranch: "main",
			}),
		).rejects.toThrow(/prompt file not found/);
	});
});

describe("defaultShellRunner", () => {
	it("runs a real command and captures stdout + exit code", async () => {
		const result = await defaultShellRunner("echo hello");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	it("returns the non-zero exit code and stderr from a failing command", async () => {
		const result = await defaultShellRunner("sh -c 'echo boom 1>&2; exit 3'");
		expect(result.exitCode).toBe(3);
		expect(result.stderr ?? "").toContain("boom");
	});
});
