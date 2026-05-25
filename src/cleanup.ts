import { spawn } from "node:child_process";

/**
 * Categorisation of a single local branch for cleanup purposes.
 *
 * `safeToDelete: true` means the branch's commits are reachable on
 * `origin/<base>` (either fast-forward-merged or content-equivalent
 * via squash-merge). Branches with commits that have NOT reached
 * origin require `--force`.
 *
 * `currently-checked-out` is a hard refusal — git itself rejects the
 * delete, but surfacing it explicitly gives a better error than the
 * raw git stderr.
 */
export type CleanupStatus =
	| "merged-fast-forward"
	| "squash-merged"
	| "unpushed"
	| "checked-out";

export type CleanupCandidate = {
	readonly branch: string;
	readonly status: CleanupStatus;
};

export type CleanupReport = {
	readonly base: string;
	readonly candidates: readonly CleanupCandidate[];
	readonly deleted: readonly string[];
	readonly skipped: readonly {
		readonly branch: string;
		readonly reason: string;
	}[];
	readonly applied: boolean;
};

export type CleanupOptions = {
	/** Base branch whose `origin/<base>` ref candidates are compared against. */
	readonly base: string;
	/** Target a single branch instead of scanning all locals. */
	readonly branch?: string;
	/** Actually delete (false = dry-run, the default). */
	readonly apply?: boolean;
	/** Override safety checks (unpushed commits). Currently-checked-out is never overridden. */
	readonly force?: boolean;
};

/**
 * Side-effects, abstracted so the cleanup orchestration is unit-testable.
 * Production wires these to real git via the `default*` helpers below.
 */
export type CleanupPorts = {
	/** Local branch names (excluding HEAD/detached). */
	listLocalBranches: () => Promise<readonly string[]>;
	/** Branch refs currently checked out by any worktree. */
	listCheckedOutBranches: () => Promise<readonly string[]>;
	/** True if every commit on `branch` is reachable from `origin/<base>`. */
	isAncestorOfRemote: (branch: string, base: string) => Promise<boolean>;
	/**
	 * True if every commit on `branch` has a content-equivalent commit
	 * on `origin/<base>` (squash-merge detection).
	 */
	contentMergedToRemote: (branch: string, base: string) => Promise<boolean>;
	/** `git branch -d <name>` (or `-D` if force). */
	deleteBranch: (branch: string, force: boolean) => Promise<void>;
};

/**
 * Plan + (optionally) execute cleanup of local branches whose work
 * has already landed on `origin/<base>`.
 *
 *   1. Enumerate candidates (`--branch <name>` overrides the scan).
 *   2. Classify each: fast-forward-merged, squash-merged, unpushed,
 *      or currently-checked-out.
 *   3. If `apply`, delete eligible candidates. `checked-out` is never
 *      deleted; `unpushed` requires `force`.
 *
 * Returns a report listing what was found, what was deleted, and what
 * was skipped (with reasons), so the CLI can render a human-readable
 * summary in both dry-run and apply modes.
 */
export async function cleanup(
	ports: CleanupPorts,
	opts: CleanupOptions,
): Promise<CleanupReport> {
	const apply = opts.apply ?? false;
	const force = opts.force ?? false;
	const base = opts.base;

	const branches =
		opts.branch !== undefined ? [opts.branch] : await ports.listLocalBranches();

	const checkedOut = new Set(await ports.listCheckedOutBranches());

	const candidates: CleanupCandidate[] = [];
	for (const branch of branches) {
		// Never delete the base itself — even if the user fat-fingers
		// `--branch main`, refuse to classify it as a cleanup target.
		if (branch === base) continue;

		if (checkedOut.has(branch)) {
			candidates.push({ branch, status: "checked-out" });
			continue;
		}

		if (await ports.isAncestorOfRemote(branch, base)) {
			candidates.push({ branch, status: "merged-fast-forward" });
			continue;
		}

		if (await ports.contentMergedToRemote(branch, base)) {
			candidates.push({ branch, status: "squash-merged" });
			continue;
		}

		candidates.push({ branch, status: "unpushed" });
	}

	const deleted: string[] = [];
	const skipped: { branch: string; reason: string }[] = [];

	if (apply) {
		for (const c of candidates) {
			if (c.status === "checked-out") {
				skipped.push({
					branch: c.branch,
					reason: "currently checked out in a worktree",
				});
				continue;
			}
			if (c.status === "unpushed" && !force) {
				skipped.push({
					branch: c.branch,
					reason: "has unpushed commits (re-run with --force to delete)",
				});
				continue;
			}
			await ports.deleteBranch(c.branch, force || c.status === "unpushed");
			deleted.push(c.branch);
		}
	}

	return { base, candidates, deleted, skipped, applied: apply };
}

/* -------------------------------------------------------------------------- */
/* Default port wiring                                                        */
/* -------------------------------------------------------------------------- */

export type DefaultPortsOptions = {
	/** Repo cwd for git invocations. */
	readonly repoRoot: string;
	/** Remote name. Defaults to "origin". */
	readonly remote?: string;
};

export function createDefaultPorts(opts: DefaultPortsOptions): CleanupPorts {
	const cwd = opts.repoRoot;
	const remote = opts.remote ?? "origin";

	return {
		listLocalBranches: async () => {
			const { stdout } = await git({
				cwd,
				args: ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
			});
			return stdout
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		},
		listCheckedOutBranches: async () => {
			// `git worktree list --porcelain` emits `branch refs/heads/<name>`
			// for each attached worktree; detached worktrees emit `detached`.
			const { stdout } = await git({
				cwd,
				args: ["worktree", "list", "--porcelain"],
			});
			const out: string[] = [];
			for (const line of stdout.split(/\r?\n/)) {
				const m = line.match(/^branch refs\/heads\/(.+)$/);
				if (m?.[1] !== undefined) out.push(m[1]);
			}
			return out;
		},
		isAncestorOfRemote: async (branch, base) => {
			// Exit 0 iff <branch> is reachable from origin/<base>.
			const { code } = await git({
				cwd,
				args: ["merge-base", "--is-ancestor", branch, `${remote}/${base}`],
				allowNonZero: true,
			});
			return code === 0;
		},
		contentMergedToRemote: async (branch, base) => {
			// `git cherry origin/<base> <branch>` emits one line per commit:
			//   `+ <sha>` for commits NOT yet on origin (true unpushed work)
			//   `- <sha>` for commits with a content-equivalent on origin
			//     (i.e., squash- or rebase-merged).
			// Branch is fully on origin iff no `+` lines are produced.
			const { stdout } = await git({
				cwd,
				args: ["cherry", `${remote}/${base}`, branch],
			});
			const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
			if (lines.length === 0) return true;
			return lines.every((l) => !l.startsWith("+"));
		},
		deleteBranch: async (branch, force) => {
			await git({
				cwd,
				args: ["branch", force ? "-D" : "-d", branch],
			});
		},
	};
}

type GitResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
};

function git(opts: {
	cwd: string;
	args: readonly string[];
	allowNonZero?: boolean;
}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", opts.args as string[], {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString("utf8");
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});

		child.on("error", reject);
		child.on("close", (code) => {
			const exit = code ?? 0;
			if (exit !== 0 && opts.allowNonZero !== true) {
				const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
				reject(
					new Error(
						`git ${opts.args.join(" ")} exited with code ${exit}${detail}`,
					),
				);
				return;
			}
			resolve({ stdout, stderr, code: exit });
		});
	});
}

/**
 * Render a cleanup report as a human-readable multi-line string for
 * the CLI to print to stdout. Pure for testability.
 */
export function formatCleanupReport(report: CleanupReport): string {
	const lines: string[] = [];
	const verb = report.applied ? "Cleanup against" : "Dry-run against";
	lines.push(`${verb} ${report.base}:`);

	if (report.candidates.length === 0) {
		lines.push("  (no local branches found)");
	} else {
		for (const c of report.candidates) {
			lines.push(`  - ${c.branch}  [${c.status}]`);
		}
	}

	if (report.applied) {
		if (report.deleted.length > 0) {
			lines.push(`Deleted (${report.deleted.length}):`);
			for (const b of report.deleted) lines.push(`  - ${b}`);
		}
		if (report.skipped.length > 0) {
			lines.push(`Skipped (${report.skipped.length}):`);
			for (const s of report.skipped) {
				lines.push(`  - ${s.branch}: ${s.reason}`);
			}
		}
		if (report.deleted.length === 0 && report.skipped.length === 0) {
			lines.push("Nothing to delete.");
		}
	} else {
		lines.push("Re-run with --apply to delete safe candidates.");
	}

	return lines.join("\n");
}
