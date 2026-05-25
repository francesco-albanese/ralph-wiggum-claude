import { describe, expect, it } from "vitest";
import { renderPrompt } from "./preprocessor.js";

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

	it("inlines a visible error marker when a shell command fails", async () => {
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

	it("truncates stderr in the shell-error marker", async () => {
		const noisyStderr = "AWS_SECRET=hunter2 ".repeat(2000);
		const rendered = await renderPrompt(
			"!`leaky-cmd`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({
					stdout: "",
					stderr: noisyStderr,
					exitCode: 1,
				}),
				maxOutputBytes: 128,
			},
		);

		expect(rendered).toMatch(/\[shell-error/);
		expect(rendered).toContain("more bytes truncated");
		expect(rendered.length).toBeLessThan(noisyStderr.length);
	});

	it("truncates shell-expression output at the 4KB cap", async () => {
		const bigStdout = "x".repeat(5000);
		const rendered = await renderPrompt(
			"!`bd memories`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: bigStdout, exitCode: 0 }),
			},
		);

		expect(rendered.length).toBeLessThan(bigStdout.length);
		const truncationMarker = rendered.match(
			/\.\.\.\((\d+) more bytes truncated\)/,
		);
		expect(truncationMarker).not.toBeNull();
		expect(Number.parseInt(truncationMarker?.[1] ?? "0", 10)).toBe(904);
		expect(rendered.startsWith("x".repeat(100))).toBe(true);
	});

	it("truncates by UTF-8 bytes, not code units, for multibyte output", async () => {
		const euros = "€".repeat(2000);
		const rendered = await renderPrompt(
			"!`echo euros`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: euros, exitCode: 0 }),
				maxOutputBytes: 100,
			},
		);

		const marker = rendered.match(/\.\.\.\((\d+) more bytes truncated\)/);
		expect(marker).not.toBeNull();
		expect(Number.parseInt(marker?.[1] ?? "0", 10)).toBe(5900);
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

	it("does not inject indentation for empty indented output", async () => {
		const template = ["text", "  !`true`", "after"].join("\n");

		const rendered = await renderPrompt(
			template,
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async () => ({ stdout: "", exitCode: 0 }),
			},
		);

		expect(rendered).toBe(["text", "", "after"].join("\n"));
	});

	it("leaves non-shell-expression backticks alone", async () => {
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

	it("forwards maxOutputBytes and timeoutMs to the shell runner", async () => {
		const seen: Array<{ maxOutputBytes?: number; timeoutMs?: number }> = [];
		await renderPrompt(
			"!`bd ready`",
			{ branch: "feat/x", targetBranch: "main" },
			{
				runShell: async (_cmd, opts) => {
					seen.push({
						maxOutputBytes: opts?.maxOutputBytes,
						timeoutMs: opts?.timeoutMs,
					});
					return { stdout: "ok", exitCode: 0 };
				},
				maxOutputBytes: 256,
				timeoutMs: 1500,
			},
		);

		expect(seen).toEqual([{ maxOutputBytes: 256, timeoutMs: 1500 }]);
	});
});
