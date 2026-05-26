import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDetachedCommand, stopCommand } from "../src/daemon.js";
import { StateStore } from "../src/state.js";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args as string[], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	});
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "ralph-daemon-"));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "README.md"), "# test\n");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runDetachedCommand", () => {
	let repo: string;
	let originalCwd: string;

	beforeEach(() => {
		repo = makeRepo();
		originalCwd = process.cwd();
		process.chdir(repo);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(repo, { recursive: true, force: true });
	});

	it("spawns a detached child and redirects output to the log", async () => {
		const script = join(repo, "child.mjs");
		writeFileSync(
			script,
			"console.log('detached-ready'); setTimeout(() => {}, 30000);\n",
		);

		const result = await runDetachedCommand(
			{ branch: "feat/detached" },
			["node", script, "run", "--branch", "feat/detached", "--detach"],
		);

		try {
			expect(result.pid).toBeGreaterThan(0);
			expect(isAlive(result.pid)).toBe(true);
			expect(result.logPath).toContain(".ralph/logs");
			expect(existsSync(result.logPath)).toBe(true);
		} finally {
			process.kill(result.pid, "SIGTERM");
		}
	});

	it("detached child survives the launching parent process exit", async () => {
		const childScript = join(repo, "child-parent-smoke.mjs");
		const parentScript = join(repo, "parent-smoke.mjs");
		const logPath = join(repo, ".ralph", "logs", "parent-smoke.log");
		writeFileSync(
			childScript,
			"console.log('child-started'); setInterval(() => console.log('tick'), 100).unref(); setTimeout(() => {}, 30000);\n",
		);
		writeFileSync(
			parentScript,
			`import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
const logPath = ${JSON.stringify(logPath)};
mkdirSync(dirname(logPath), { recursive: true });
const fd = openSync(logPath, "a");
const child = spawn(process.execPath, [${JSON.stringify(childScript)}], {
  detached: true,
  stdio: ["ignore", fd, fd],
});
closeSync(fd);
child.unref();
console.log(JSON.stringify({ pid: child.pid, logPath }));
`,
		);

		const raw = execFileSync(process.execPath, [parentScript], {
			cwd: repo,
			encoding: "utf8",
		});
		const result = JSON.parse(raw) as { pid: number; logPath: string };

		try {
			await sleep(150);
			expect(isAlive(result.pid)).toBe(true);
			expect(readFileSync(result.logPath, "utf8")).toContain("child-started");
		} finally {
			process.kill(result.pid, "SIGTERM");
		}
	});

	it("stopCommand sends SIGTERM to the selected pid", async () => {
		new StateStore(repo).write({
			pid: process.pid,
			branch: "feat/stop",
			agent: "claude",
			model: "sonnet",
			startedAt: "2026-05-25T00:00:00.000Z",
			iteration: 1,
			currentBead: null,
			tasksDone: [],
			tokens: {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreateTokens: 0,
				cacheReadTokens: 0,
			},
			costUsd: 0,
			logPath: join(repo, ".ralph/logs/test.log"),
			prUrl: "",
		});
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		try {
			await stopCommand(process.pid);
			expect(kill).toHaveBeenCalledWith(process.pid, 0);
			expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
		} finally {
			kill.mockRestore();
		}
	});
});
