import { describe, expect, it } from "vitest";
import {
	cleanup,
	type CleanupPorts,
	formatCleanupReport,
} from "../src/cleanup.js";

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
