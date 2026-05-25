import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, createDefaultPorts } from "../src/cleanup.js";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args as string[], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
}

function makeRepoWithOrigin(): { repo: string; origin: string } {
	const origin = mkdtempSync(join(tmpdir(), "ralph-cleanup-origin-"));
	execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);

	const repo = mkdtempSync(join(tmpdir(), "ralph-cleanup-repo-"));
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	git(repo, ["remote", "add", "origin", origin]);

	writeFileSync(join(repo, "README.md"), "# test\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-q", "-m", "init"]);
	git(repo, ["push", "-q", "-u", "origin", "main"]);

	return { repo, origin };
}

function cleanupAll(...dirs: readonly string[]): void {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

describe("cleanup (real git)", () => {
	let repo: string;
	let origin: string;

	beforeEach(() => {
		const made = makeRepoWithOrigin();
		repo = made.repo;
		origin = made.origin;
	});

	afterEach(() => {
		cleanupAll(repo, origin);
	});

	it("identifies a fast-forward-merged branch as safe-to-delete and deletes it on --apply", async () => {
		git(repo, ["checkout", "-q", "-b", "feat/ff"]);
		writeFileSync(join(repo, "ff.txt"), "ff\n");
		git(repo, ["add", "ff.txt"]);
		git(repo, ["commit", "-q", "-m", "ff work"]);

		git(repo, ["push", "-q", "-u", "origin", "feat/ff"]);
		git(repo, ["checkout", "-q", "main"]);
		git(repo, ["merge", "-q", "--ff-only", "feat/ff"]);
		git(repo, ["push", "-q", "origin", "main"]);

		const ports = createDefaultPorts({ repoRoot: repo });
		const report = await cleanup(ports, { base: "main", apply: true });

		expect(report.deleted).toContain("feat/ff");
		expect(git(repo, ["branch", "--list", "feat/ff"]).trim()).toBe("");
	});

	it("identifies a squash-merged branch as safe-to-delete via git cherry", async () => {
		git(repo, ["checkout", "-q", "-b", "feat/squash"]);
		writeFileSync(join(repo, "squash.txt"), "squash\n");
		git(repo, ["add", "squash.txt"]);
		git(repo, ["commit", "-q", "-m", "squash work"]);

		git(repo, ["checkout", "-q", "main"]);
		writeFileSync(join(repo, "squash.txt"), "squash\n");
		git(repo, ["add", "squash.txt"]);
		git(repo, ["commit", "-q", "-m", "squash: feat/squash"]);
		git(repo, ["push", "-q", "origin", "main"]);

		const ports = createDefaultPorts({ repoRoot: repo });
		const report = await cleanup(ports, { base: "main", apply: true });

		const candidate = report.candidates.find(
			(c) => c.branch === "feat/squash",
		);
		expect(candidate).toBeDefined();
		expect(candidate?.status).toBe("squash-merged");
		expect(report.deleted).toContain("feat/squash");
		expect(git(repo, ["branch", "--list", "feat/squash"]).trim()).toBe("");
	});

	it("refuses to delete a branch with unpushed commits without --force", async () => {
		git(repo, ["checkout", "-q", "-b", "feat/wip"]);
		writeFileSync(join(repo, "wip.txt"), "wip\n");
		git(repo, ["add", "wip.txt"]);
		git(repo, ["commit", "-q", "-m", "wip work"]);
		git(repo, ["checkout", "-q", "main"]);

		const ports = createDefaultPorts({ repoRoot: repo });
		const report = await cleanup(ports, { base: "main", apply: true });

		expect(report.deleted).not.toContain("feat/wip");
		expect(report.skipped.find((s) => s.branch === "feat/wip")?.reason).toMatch(
			/unpushed/i,
		);
		expect(git(repo, ["branch", "--list", "feat/wip"]).trim()).toBe("feat/wip");
	});

	it("refuses to delete a branch currently checked out in a worktree", async () => {
		git(repo, ["checkout", "-q", "-b", "feat/active"]);
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, ["add", "a.txt"]);
		git(repo, ["commit", "-q", "-m", "active"]);
		git(repo, ["push", "-q", "-u", "origin", "feat/active"]);
		git(repo, ["checkout", "-q", "main"]);
		git(repo, ["merge", "-q", "--ff-only", "feat/active"]);
		git(repo, ["push", "-q", "origin", "main"]);

		const wtPath = join(repo, ".wt", "active");
		git(repo, ["worktree", "add", "-q", wtPath, "feat/active"]);

		try {
			const ports = createDefaultPorts({ repoRoot: repo });
			const report = await cleanup(ports, {
				base: "main",
				apply: true,
				force: true,
			});

			const candidate = report.candidates.find(
				(c) => c.branch === "feat/active",
			);
			expect(candidate?.status).toBe("checked-out");
			expect(report.deleted).not.toContain("feat/active");
			expect(
				report.skipped.find((s) => s.branch === "feat/active")?.reason,
			).toMatch(/checked out/i);
		} finally {
			git(repo, ["worktree", "remove", "-f", wtPath]);
		}
	});
});
