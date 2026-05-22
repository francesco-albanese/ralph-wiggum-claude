import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBranch } from "../src/branch.js";
import { WorktreeManager } from "../src/worktree.js";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args as string[], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "ralph-worktree-"));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "README.md"), "# test\n");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

describe("WorktreeManager", () => {
	let repo: string;

	beforeEach(() => {
		repo = makeRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("creates .ralph/worktrees/<slug>/ attached to the source branch", async () => {
		const branch = parseBranch("feat/x");
		const mgr = new WorktreeManager({ repoRoot: repo });

		const wt = await mgr.create(branch);

		try {
			expect(wt.path).toBe(join(repo, ".ralph", "worktrees", "feat%2Fx"));
			expect(existsSync(wt.path)).toBe(true);

			const head = git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
			expect(head).toBe("feat/x");
		} finally {
			await mgr.remove(wt);
		}
	});

	it("slugifies nested paths into a collision-safe directory name", async () => {
		const branch = parseBranch("feat/area/sub-task");
		const mgr = new WorktreeManager({ repoRoot: repo });

		const wt = await mgr.create(branch);
		try {
			expect(wt.path).toBe(
				join(repo, ".ralph", "worktrees", "feat%2Farea%2Fsub-task"),
			);
		} finally {
			await mgr.remove(wt);
		}
	});

	it("removes the worktree directory and prunes the branch on remove()", async () => {
		const branch = parseBranch("feat/cleanup");
		const mgr = new WorktreeManager({ repoRoot: repo });

		const wt = await mgr.create(branch);
		expect(existsSync(wt.path)).toBe(true);

		await mgr.remove(wt);

		expect(existsSync(wt.path)).toBe(false);

		const branches = git(repo, ["branch", "--list", "feat/cleanup"]).trim();
		expect(branches).toBe("");

		const list = git(repo, ["worktree", "list", "--porcelain"]);
		expect(list).not.toContain("feat%2Fcleanup");
	});

	it("rejects re-creating the same worktree", async () => {
		const branch = parseBranch("feat/dup");
		const mgr = new WorktreeManager({ repoRoot: repo });

		const wt = await mgr.create(branch);
		try {
			await expect(mgr.create(branch)).rejects.toThrow();
		} finally {
			await mgr.remove(wt);
		}
	});

	it("cleans up worktree even if caller throws between create and remove", async () => {
		const branch = parseBranch("feat/crash");
		const mgr = new WorktreeManager({ repoRoot: repo });

		const wt = await mgr.create(branch);
		try {
			throw new Error("simulated agent crash");
		} catch {
			// expected
		} finally {
			await mgr.remove(wt);
		}

		expect(existsSync(wt.path)).toBe(false);
		const branches = git(repo, ["branch", "--list", "feat/crash"]).trim();
		expect(branches).toBe("");
	});

	it("remove() is idempotent — second call is a no-op", async () => {
		const branch = parseBranch("feat/idempotent");
		const mgr = new WorktreeManager({ repoRoot: repo });

		const wt = await mgr.create(branch);
		await mgr.remove(wt);
		await mgr.remove(wt);
		expect(existsSync(wt.path)).toBe(false);
	});
});
