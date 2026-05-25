import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentRunner,
	captureRepoRoot,
	runInWorktree,
} from "../src/run.js";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args as string[], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "ralph-run-"));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "README.md"), "# test\n");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

describe("runInWorktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = makeRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("rejects an invalid branch prefix before touching git", async () => {
		const agent: AgentRunner = async () => {
			throw new Error("agent should not be invoked");
		};

		await expect(
			runInWorktree({ branch: "random/foo", repoRoot: repo, agent }),
		).rejects.toThrow(/must start with one of:/);

		// .ralph dir should not even exist
		expect(existsSync(join(repo, ".ralph"))).toBe(false);
	});

	it("creates the worktree, invokes the agent with cwd = worktree path, then cleans up", async () => {
		let observedCwd: string | undefined;

		const agent: AgentRunner = async ({ cwd }) => {
			observedCwd = cwd;
			expect(existsSync(cwd)).toBe(true);
		};

		await runInWorktree({ branch: "feat/x", repoRoot: repo, agent });

		const expected = join(repo, ".ralph", "worktrees", "feat%2Fx");
		expect(observedCwd).toBe(expected);
		// worktree dir removed, branch reference preserved
		expect(existsSync(expected)).toBe(false);
		expect(git(repo, ["branch", "--list", "feat/x"]).trim()).toBe("feat/x");
	});

	it("removes the worktree when the agent throws (crash path)", async () => {
		const agent: AgentRunner = async () => {
			throw new Error("boom");
		};

		await expect(
			runInWorktree({ branch: "feat/crash", repoRoot: repo, agent }),
		).rejects.toThrow(/boom/);

		const path = join(repo, ".ralph", "worktrees", "feat%2Fcrash");
		expect(existsSync(path)).toBe(false);
		// Crash path must NOT destroy the branch — agent commits live there.
		expect(git(repo, ["branch", "--list", "feat/crash"]).trim()).toBe(
			"feat/crash",
		);
	});

	it("removes the worktree when the agent is aborted via the supplied signal (Ctrl-C path)", async () => {
		const ac = new AbortController();

		// Wait until the agent has actually entered before aborting —
		// otherwise the abort fires during `git worktree add` and the
		// pre-agent return path takes over, never exercising mid-flight
		// cancellation. A 10ms timer was racy.
		let agentStarted: () => void = () => {};
		const startedPromise = new Promise<void>((r) => {
			agentStarted = r;
		});

		const agent: AgentRunner = async ({ signal }) => {
			agentStarted();
			await new Promise<void>((resolve, reject) => {
				if (signal.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
		};

		const promise = runInWorktree({
			branch: "feat/ctrl-c",
			repoRoot: repo,
			agent,
			signal: ac.signal,
		});

		await startedPromise;
		ac.abort();

		await expect(promise).rejects.toThrow();

		const path = join(repo, ".ralph", "worktrees", "feat%2Fctrl-c");
		expect(existsSync(path)).toBe(false);
		// Ctrl-C path must NOT destroy the branch — same reason as crash.
		expect(git(repo, ["branch", "--list", "feat/ctrl-c"]).trim()).toBe(
			"feat/ctrl-c",
		);
	});

	it("returns silently (does NOT throw) when the signal is already aborted before the agent starts", async () => {
		// Regression guard: pre-agent abort must surface through the
		// caller's `interrupted` path, NOT as a generic crash. Throwing
		// here would bypass runCommand's `orchResult === undefined →
		// outcome: "interrupted"` branch and the CLI would print a
		// crash instead of a clean exit-130.
		const ac = new AbortController();
		ac.abort();

		const agent: AgentRunner = async () => {
			throw new Error("agent should NOT run after pre-agent abort");
		};

		await expect(
			runInWorktree({
				branch: "feat/pre-abort",
				repoRoot: repo,
				agent,
				signal: ac.signal,
			}),
		).resolves.toBeUndefined();

		// Worktree still cleaned up; branch ref preserved.
		const path = join(repo, ".ralph", "worktrees", "feat%2Fpre-abort");
		expect(existsSync(path)).toBe(false);
		expect(git(repo, ["branch", "--list", "feat/pre-abort"]).trim()).toBe(
			"feat/pre-abort",
		);
	});
});

describe("captureRepoRoot", () => {
	let repo: string;
	let originalCwd: string;

	beforeEach(() => {
		repo = makeRepo();
		originalCwd = process.cwd();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(repo, { recursive: true, force: true });
	});

	it("returns the main checkout path even when invoked from inside a linked worktree", async () => {
		// Regression guard: `git rev-parse --show-toplevel` would return
		// the linked worktree's path here, causing nested ralph runs to
		// stack `.ralph/worktrees/` directories. `captureRepoRoot` must
		// resolve to the MAIN checkout no matter the cwd.
		const linkedPath = join(repo, ".ralph", "worktrees", "feat%2Fnested");
		git(repo, ["worktree", "add", "-b", "feat/nested", linkedPath]);

		// Some platforms (macOS) place tmpdir under /private; resolve
		// symlinks so the assertion compares canonical paths.
		const expected = realpathSync(repo);
		process.chdir(linkedPath);

		const root = await captureRepoRoot();
		expect(realpathSync(root)).toBe(expected);
	});
});
