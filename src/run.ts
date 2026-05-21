import { spawn } from "node:child_process";
import { streamAgentText } from "./stream.js";

export interface RunOptions {
	readonly branch: string;
}

/**
 * Walking-skeleton end-to-end pipe:
 *   1. capture target (base) branch
 *   2. checkout the supplied source branch
 *   3. spawn Claude Code once in cwd, stream its text to stdout
 *   4. push the branch and open a draft PR against the captured base
 *   5. return the PR URL
 *
 * Scope is deliberately minimal — no worktree, no iteration loop,
 * no completion detection, no agent abstraction. Subsequent slices
 * (2yb, 3oo, n9e, ...) build on top of this skeleton.
 */
export async function runCommand(opts: RunOptions): Promise<string> {
	const { branch } = opts;

	const baseBranch = await captureBaseBranch();
	if (baseBranch.length === 0) {
		throw new Error("could not determine current branch (detached HEAD?)");
	}
	if (baseBranch === branch) {
		throw new Error(
			`--branch ${branch} matches the current branch; supply a new branch name`,
		);
	}

	await ensureCleanWorktree();

	const exists = await hasLocalBranch(branch);
	await git(exists ? ["checkout", branch] : ["checkout", "-b", branch]);

	await spawnAgent();

	const commitsAhead = await countCommitsAhead(baseBranch);
	if (commitsAhead === 0) {
		throw new Error(
			`agent produced no commits on ${branch}; refusing to open an empty PR`,
		);
	}

	await git(["push", "-u", "origin", branch]);

	return await createDraftPr({ base: baseBranch, head: branch });
}

async function captureBaseBranch(): Promise<string> {
	const { stdout } = await runProc("git", ["branch", "--show-current"]);
	return stdout.trim();
}

async function ensureCleanWorktree(): Promise<void> {
	const { stdout } = await runProc("git", ["status", "--porcelain"]);
	if (stdout.trim().length > 0) {
		throw new Error(
			"working tree is not clean; commit or stash changes before running ralph",
		);
	}
}

async function hasLocalBranch(branch: string): Promise<boolean> {
	try {
		await runProc("git", ["show-ref", "--verify", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

async function countCommitsAhead(base: string): Promise<number> {
	const { stdout } = await runProc("git", [
		"rev-list",
		`${base}..HEAD`,
		"--count",
	]);
	const n = Number.parseInt(stdout.trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

async function createDraftPr(args: {
	base: string;
	head: string;
}): Promise<string> {
	const { stdout } = await runProc("gh", [
		"pr",
		"create",
		"--draft",
		"--base",
		args.base,
		"--head",
		args.head,
		"--fill",
	]);
	return stdout.trim();
}

async function spawnAgent(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"claude",
			[
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
			],
			{ stdio: ["inherit", "pipe", "inherit"] },
		);

		const stdout = child.stdout;
		if (stdout === null) {
			reject(new Error("claude subprocess produced no stdout"));
			return;
		}

		const streaming = streamAgentText(stdout, process.stdout);

		child.on("error", reject);
		child.on("close", (code) => {
			streaming
				.then(() => {
					if (code === 0) {
						resolve();
					} else {
						reject(new Error(`claude exited with code ${code}`));
					}
				})
				.catch(reject);
		});
	});
}

async function git(args: readonly string[]): Promise<void> {
	await runProc("git", args);
}

interface ProcResult {
	readonly stdout: string;
	readonly stderr: string;
}

function runProc(cmd: string, args: readonly string[]): Promise<ProcResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args as string[], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				const trimmed = stderr.trim();
				const detail = trimmed.length > 0 ? `: ${trimmed}` : "";
				reject(
					new Error(
						`${cmd} ${args.join(" ")} exited with code ${code}${detail}`,
					),
				);
			}
		});
	});
}
