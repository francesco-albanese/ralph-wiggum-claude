import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanup,
	type CleanupPorts,
	createDefaultPorts,
	formatCleanupReport,
} from "../src/cleanup.js";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args as string[], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
}

/**
 * Build a local repo + a bare "origin" remote. Returns paths so each
 * test can wire branches and pushes against a realistic two-repo setup
 * without touching the network.
 */
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

describe("cleanup (pure orchestration)", () => {
	function fakePorts(overrides: Partial<CleanupPorts> = {}): CleanupPorts {
		return {
			listLocalBranches: async () => [],
			listCheckedOutBranches: async () => [],
			isAncestorOfRemote: async () => false,
			contentMergedToRemote: async () => false,
			deleteBranch: async () => {},
			...overrides,
		};
	}

	it("dry-run never deletes, even for safe candidates", async () => {
		const calls: string[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["feat/done"],
			isAncestorOfRemote: async () => true,
			deleteBranch: async (b) => {
				calls.push(b);
			},
		});

		const report = await cleanup(ports, { base: "main" });

		expect(calls).toEqual([]);
		expect(report.applied).toBe(false);
		expect(report.deleted).toEqual([]);
		expect(report.candidates).toEqual([
			{ branch: "feat/done", status: "merged-fast-forward" },
		]);
	});

	it("--apply deletes merged branches", async () => {
		const deleted: { branch: string; force: boolean }[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["feat/done"],
			isAncestorOfRemote: async () => true,
			deleteBranch: async (branch, force) => {
				deleted.push({ branch, force });
			},
		});

		const report = await cleanup(ports, { base: "main", apply: true });

		expect(deleted).toEqual([{ branch: "feat/done", force: false }]);
		expect(report.deleted).toEqual(["feat/done"]);
		expect(report.applied).toBe(true);
	});

	it("never deletes the base branch even if it ends up in the list", async () => {
		const deleted: string[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["main"],
			isAncestorOfRemote: async () => true,
			deleteBranch: async (b) => {
				deleted.push(b);
			},
		});

		const report = await cleanup(ports, { base: "main", apply: true });

		expect(deleted).toEqual([]);
		expect(report.candidates).toEqual([]);
	});

	it("refuses to delete a branch with unpushed commits unless --force", async () => {
		const deleted: string[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["feat/wip"],
			isAncestorOfRemote: async () => false,
			contentMergedToRemote: async () => false,
			deleteBranch: async (b) => {
				deleted.push(b);
			},
		});

		const report = await cleanup(ports, { base: "main", apply: true });

		expect(deleted).toEqual([]);
		expect(report.skipped).toEqual([
			{
				branch: "feat/wip",
				reason: "has unpushed commits (re-run with --force to delete)",
			},
		]);
	});

	it("--force deletes branches with unpushed commits", async () => {
		const deleted: { branch: string; force: boolean }[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["feat/wip"],
			isAncestorOfRemote: async () => false,
			contentMergedToRemote: async () => false,
			deleteBranch: async (branch, force) => {
				deleted.push({ branch, force });
			},
		});

		const report = await cleanup(ports, {
			base: "main",
			apply: true,
			force: true,
		});

		expect(deleted).toEqual([{ branch: "feat/wip", force: true }]);
		expect(report.deleted).toEqual(["feat/wip"]);
	});

	it("never deletes a branch currently checked out in a worktree, even with --force", async () => {
		const deleted: string[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["feat/active"],
			listCheckedOutBranches: async () => ["feat/active"],
			isAncestorOfRemote: async () => true,
			deleteBranch: async (b) => {
				deleted.push(b);
			},
		});

		const report = await cleanup(ports, {
			base: "main",
			apply: true,
			force: true,
		});

		expect(deleted).toEqual([]);
		expect(report.skipped).toEqual([
			{
				branch: "feat/active",
				reason: "currently checked out in a worktree",
			},
		]);
	});

	it("classifies squash-merged branches as safe and deletes them with -D (git's -d would refuse)", async () => {
		const deleted: { branch: string; force: boolean }[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["feat/squashed"],
			isAncestorOfRemote: async () => false,
			contentMergedToRemote: async () => true,
			deleteBranch: async (branch, force) => {
				deleted.push({ branch, force });
			},
		});

		const report = await cleanup(ports, { base: "main", apply: true });

		expect(report.candidates).toEqual([
			{ branch: "feat/squashed", status: "squash-merged" },
		]);
		// Squash-merge → git's SHA-ancestry check rejects `-d`. Our cherry
		// check has already proved content equivalence, so `-D` is correct.
		expect(deleted).toEqual([{ branch: "feat/squashed", force: true }]);
	});

	it("uses -d (not -D) for fast-forward-merged branches", async () => {
		// Inverse of the squash-merge case: fast-forward merges ARE
		// SHA-reachable from origin/<base>, so git's safer `-d` works.
		// Using `-D` everywhere would silently delete branches a refined
		// classifier later marks unsafe — `-d` is a final backstop.
		const deleted: { branch: string; force: boolean }[] = [];
		const ports = fakePorts({
			listLocalBranches: async () => ["feat/ff"],
			isAncestorOfRemote: async () => true,
			deleteBranch: async (branch, force) => {
				deleted.push({ branch, force });
			},
		});

		await cleanup(ports, { base: "main", apply: true });
		expect(deleted).toEqual([{ branch: "feat/ff", force: false }]);
	});

	it("--branch <name> targets a single branch without scanning all locals", async () => {
		const listed = { called: false };
		const ports = fakePorts({
			listLocalBranches: async () => {
				listed.called = true;
				return ["should-not-be-scanned"];
			},
			isAncestorOfRemote: async () => true,
		});

		const report = await cleanup(ports, {
			base: "main",
			branch: "feat/only",
		});

		expect(listed.called).toBe(false);
		expect(report.candidates).toEqual([
			{ branch: "feat/only", status: "merged-fast-forward" },
		]);
	});
});

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
		// feat/ff created from main, commit, merged into main on origin
		// via fast-forward. Local feat/ff should be safe to delete.
		git(repo, ["checkout", "-q", "-b", "feat/ff"]);
		writeFileSync(join(repo, "ff.txt"), "ff\n");
		git(repo, ["add", "ff.txt"]);
		git(repo, ["commit", "-q", "-m", "ff work"]);

		// Push feat/ff so origin has the commits, then fast-forward main.
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
		// feat/squash makes one change and is squash-merged into main on origin.
		// `git branch --merged` would NOT flag it (different SHA), but
		// `git cherry` will recognise the content as already-on-origin.
		git(repo, ["checkout", "-q", "-b", "feat/squash"]);
		writeFileSync(join(repo, "squash.txt"), "squash\n");
		git(repo, ["add", "squash.txt"]);
		git(repo, ["commit", "-q", "-m", "squash work"]);

		// Simulate a GitHub squash-merge: cherry-pick the change onto main
		// (creating a new commit with the same tree but a different SHA),
		// push main to origin, and leave feat/squash locally unpushed.
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
		// End-to-end: squash-merge classification must drive an actual
		// `git branch -d` so cleanup --apply genuinely reclaims the ref,
		// not just paints it green in the report.
		expect(report.deleted).toContain("feat/squash");
		expect(git(repo, ["branch", "--list", "feat/squash"]).trim()).toBe("");
	});

	it("refuses to delete a branch with unpushed commits without --force", async () => {
		// feat/wip has commits that exist nowhere on origin.
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
		// Attach a linked worktree on feat/active, then try to clean it up.
		git(repo, ["checkout", "-q", "-b", "feat/active"]);
		writeFileSync(join(repo, "a.txt"), "a\n");
		git(repo, ["add", "a.txt"]);
		git(repo, ["commit", "-q", "-m", "active"]);
		git(repo, ["push", "-q", "-u", "origin", "feat/active"]);
		// Fast-forward main on origin so feat/active *would* otherwise
		// be classified as merged-safe.
		git(repo, ["checkout", "-q", "main"]);
		git(repo, ["merge", "-q", "--ff-only", "feat/active"]);
		git(repo, ["push", "-q", "origin", "main"]);

		// Re-attach feat/active in a separate worktree directory.
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
			expect(report.skipped.find((s) => s.branch === "feat/active")?.reason).toMatch(
				/checked out/i,
			);
		} finally {
			git(repo, ["worktree", "remove", "-f", wtPath]);
		}
	});
});

describe("formatCleanupReport", () => {
	it("renders a dry-run report with a re-run hint", () => {
		const out = formatCleanupReport({
			base: "main",
			candidates: [{ branch: "feat/a", status: "merged-fast-forward" }],
			deleted: [],
			skipped: [],
			applied: false,
		});
		expect(out).toContain("Dry-run against main");
		expect(out).toContain("feat/a");
		expect(out).toContain("--apply");
	});

	it("hint is silent when no candidate is actually deletable (only checked-out)", () => {
		const out = formatCleanupReport({
			base: "main",
			candidates: [{ branch: "feat/active", status: "checked-out" }],
			deleted: [],
			skipped: [],
			applied: false,
		});
		expect(out).toContain("feat/active");
		// No `--apply` hint — would be misleading because --apply still
		// can't delete a checked-out branch.
		expect(out).not.toContain("--apply");
	});

	it("hint nudges towards --force when only unpushed candidates exist", () => {
		const out = formatCleanupReport({
			base: "main",
			candidates: [{ branch: "feat/wip", status: "unpushed" }],
			deleted: [],
			skipped: [],
			applied: false,
		});
		expect(out).toContain("--apply --force");
	});

	it("renders an apply report with deletions and skips", () => {
		const out = formatCleanupReport({
			base: "main",
			candidates: [
				{ branch: "feat/a", status: "merged-fast-forward" },
				{ branch: "feat/b", status: "unpushed" },
			],
			deleted: ["feat/a"],
			skipped: [{ branch: "feat/b", reason: "has unpushed commits" }],
			applied: true,
		});
		expect(out).toContain("Cleanup against main");
		expect(out).toContain("Deleted (1)");
		expect(out).toContain("Skipped (1)");
		expect(out).toContain("feat/a");
		expect(out).toContain("feat/b");
	});
});
