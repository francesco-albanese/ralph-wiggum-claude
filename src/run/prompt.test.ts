import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInvocationPrompt } from "./prompt.js";

describe("loadInvocationPrompt", () => {
	let repoRoot: string;
	let worktreeRoot: string;

	beforeEach(async () => {
		repoRoot = await mkdtemp(join(tmpdir(), "ralph-prompt-host-"));
		worktreeRoot = await mkdtemp(join(tmpdir(), "ralph-prompt-wt-"));
		await mkdir(join(repoRoot, ".ralph"), { recursive: true });
	});

	afterEach(async () => {
		await rm(repoRoot, { recursive: true, force: true });
		await rm(worktreeRoot, { recursive: true, force: true });
	});

	it("reads the host prompt and expands shell expressions in the worktree", async () => {
		await writeFile(
			join(repoRoot, ".ralph", "prompt.md"),
			"branch={{BRANCH}}\n!`pwd`\n",
			"utf8",
		);

		const rendered = await loadInvocationPrompt({
			repoRoot,
			worktreeRoot,
			context: { branch: "feat/x", targetBranch: "main" },
		});

		expect(rendered).toBe(`branch=feat/x\n${realpathSync(worktreeRoot)}\n`);
	});
});
