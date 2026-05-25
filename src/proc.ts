import { spawn } from "node:child_process";

export type ProcResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
};

export type ProcOptions = {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	/**
	 * When `true`, a non-zero exit resolves with `code` set instead of
	 * rejecting. Useful for commands whose non-zero exit is a meaningful
	 * boolean (e.g. `git merge-base --is-ancestor`).
	 */
	readonly allowNonZero?: boolean;
};

/**
 * Spawn `cmd` with an explicit argv array (no shell interpolation),
 * collect stdout/stderr, and resolve with `{ stdout, stderr, code }`.
 *
 * On non-zero exit, rejects with a message that includes the command,
 * args, exit code, and trimmed stderr — unless `allowNonZero` is set,
 * in which case the result is returned and the caller inspects `code`.
 *
 * Single source of truth for "run an external CLI" across the codebase
 * — used by `run.ts` (git/gh wiring) and `cleanup.ts` (git wiring).
 */
export function runProc(opts: ProcOptions): Promise<ProcResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(opts.cmd, opts.args as string[], {
			cwd: opts.cwd,
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
		child.on("close", (code, signal) => {
			// Signal-terminated children expose `code === null` and a
			// non-null signal name. `code ?? 0` would silently mask that
			// as exit-0 success, so route it through the failure branch
			// (unless the caller explicitly tolerates non-zero, e.g.
			// `git merge-base --is-ancestor` whose exit code IS the answer).
			if (signal !== null && opts.allowNonZero !== true) {
				const trimmed = stderr.trim();
				const detail = trimmed.length > 0 ? `: ${trimmed}` : "";
				reject(
					new Error(
						`${opts.cmd} ${opts.args.join(" ")} terminated by signal ${signal}${detail}`,
					),
				);
				return;
			}
			const exit = code ?? 0;
			if (exit !== 0 && opts.allowNonZero !== true) {
				const trimmed = stderr.trim();
				const detail = trimmed.length > 0 ? `: ${trimmed}` : "";
				reject(
					new Error(
						`${opts.cmd} ${opts.args.join(" ")} exited with code ${exit}${detail}`,
					),
				);
				return;
			}
			resolve({ stdout, stderr, code: exit });
		});
	});
}
