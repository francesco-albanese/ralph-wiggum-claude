import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { RunShell, ShellResult } from "./preprocessor.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 4096;
export const DEFAULT_TIMEOUT_MS = 30_000;

export const defaultShellRunner: RunShell = (cmd, opts) => {
	const maxOutputBytes = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const hardCap = Math.max(maxOutputBytes * 4, 1024);

	return new Promise<ShellResult>((resolve) => {
		const child = spawn("/bin/sh", ["-c", cmd], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let timedOut = false;
		let resolved = false;

		const timer = setTimeout(() => {
			timedOut = true;
			if (!child.killed) child.kill("SIGTERM");
		}, timeoutMs);

		const collect = (
			chunks: Buffer[],
			current: number,
			chunk: Buffer,
		): number => {
			if (current >= hardCap) return current;
			const remaining = hardCap - current;
			if (chunk.byteLength <= remaining) {
				chunks.push(chunk);
				return current + chunk.byteLength;
			}
			chunks.push(chunk.subarray(0, remaining));
			if (!child.killed) child.kill("SIGTERM");
			return hardCap;
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes = collect(stdoutChunks, stdoutBytes, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes = collect(stderrChunks, stderrBytes, chunk);
		});

		const finish = (stdout: string, stderr: string, exitCode: number): void => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode });
		};

		child.on("error", (err) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			const sep = stderr.length > 0 ? "\n" : "";
			finish(stdout, `${stderr}${sep}${err.message}`, -1);
		});

		child.on("close", (code, signal) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (timedOut) {
				const sep = stderr.length > 0 ? "\n" : "";
				finish(
					stdout,
					`${stderr}${sep}[timeout after ${timeoutMs}ms]`,
					128 + (osConstants.signals.SIGTERM ?? 15),
				);
				return;
			}
			finish(stdout, stderr, code ?? signalExitCode(signal));
		});
	});
};

function signalExitCode(signal: NodeJS.Signals | null): number {
	if (signal === null) return 1;
	const signo = osConstants.signals[signal];
	return signo !== undefined ? 128 + signo : 128;
}
