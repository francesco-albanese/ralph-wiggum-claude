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
 * `remove()` runs `git worktree remove --force` and then deletes the
 * branch reference. Both steps tolerate "already gone" — remove is
 * safe to call from a `finally` block and from a signal handler that
 * may fire while the worktree is half-built.
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
		// is "no leftover state", not a perfect 1:1 inverse of create().
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

		// Delete the local branch even on the success path. The agent's
		// commits have already been pushed to `origin/<branch>` by the
		// time we get here, and the PR points at the remote ref — so the
		// local branch is scratch state. Leaving it around would block
		// the next `ralph run --branch <same-name>`.
		await this.#tryGit(["branch", "-D", wt.branch.name]);
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
