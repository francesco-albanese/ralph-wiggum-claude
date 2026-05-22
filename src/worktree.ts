import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ParsedBranch } from "./branch.js";

/**
 * One git worktree under `.ralph/worktrees/<slug>/` plus the branch
 * reference it's attached to. The agent subprocess runs with this as
 * its cwd. Removed on clean exit, agent crash, or Ctrl-C.
 */
export type Worktree = {
	readonly path: string;
	readonly branch: ParsedBranch;
};

export type WorktreeManagerOptions = {
	readonly repoRoot: string;
};

/**
 * Manages the lifecycle of `.ralph/worktrees/<slug>/` directories.
 *
 * `create()` creates the parent directory if missing and runs
 * `git worktree add -b <branch> <path>` so the new branch is created
 * fresh from the current HEAD.
 *
 * `remove()` only tears down the worktree directory; it never deletes
 * the branch reference. The branch holds the agent's commits, and a
 * `finally`-block cleanup runs on every exit path — including after a
 * `git push` failure where those commits have NOT yet reached `origin`.
 * Deleting the branch there would silently destroy work. Reusing the
 * same `--branch` name on a later run is rejected by `create()` (the
 * branch already exists); that's a user-actionable error, not a reason
 * to drop commits.
 */
export class WorktreeManager {
	readonly #repoRoot: string;

	constructor(opts: WorktreeManagerOptions) {
		this.#repoRoot = opts.repoRoot;
	}

	async create(branch: ParsedBranch): Promise<Worktree> {
		const path = join(this.#repoRoot, ".ralph", "worktrees", branch.slug);
		await mkdir(dirname(path), { recursive: true });

		await this.#git(["worktree", "add", "-b", branch.name, path, "HEAD"]);

		return { path, branch };
	}

	async remove(wt: Worktree): Promise<void> {
		// git worktree remove fails if the dir is already gone or the
		// worktree was never registered. Swallow — the goal of remove()
		// is "no leftover worktree directory", not a perfect 1:1 inverse
		// of create(). The branch reference is intentionally left alone.
		const removed = await this.#tryGit([
			"worktree",
			"remove",
			"--force",
			wt.path,
		]);
		if (!removed) {
			await rm(wt.path, { recursive: true, force: true });
			await this.#tryGit(["worktree", "prune"]);
		}
	}

	#git(args: readonly string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn("git", args as string[], {
				cwd: this.#repoRoot,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});

			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
				} else {
					const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
					reject(
						new Error(
							`git ${args.join(" ")} exited with code ${code}${detail}`,
						),
					);
				}
			});
		});
	}

	async #tryGit(args: readonly string[]): Promise<boolean> {
		try {
			await this.#git(args);
			return true;
		} catch {
			return false;
		}
	}
}
