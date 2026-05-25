import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { CostBreakdown } from "./cost.js";
import type { IterationUsage, ParsedStreamEvent } from "./stream.js";

/**
 * JSON-line shapes written to `.ralph/logs/<timestamp>-<pid>.log`.
 * The discriminator field is `event` so the file is greppable
 * (`grep '"event":"iteration_end"' .ralph/logs/*.log`).
 */
export type LogEvent =
	| {
			readonly event: "invocation_start";
			readonly ts: string;
			readonly pid: number;
			readonly branch?: string;
			readonly maxIter?: number;
	  }
	| {
			readonly event: "iteration_start";
			readonly ts: string;
			readonly iteration: number;
	  }
	| {
			readonly event: "stream";
			readonly ts: string;
			readonly iteration: number;
			readonly payload: ParsedStreamEvent;
	  }
	| {
			readonly event: "iteration_end";
			readonly ts: string;
			readonly iteration: number;
			readonly outcome: string;
			readonly exitCode: number | null;
			readonly taskClosed: boolean;
			readonly usage: IterationUsage;
			readonly cost: CostBreakdown;
			readonly model?: string;
	  }
	| {
			readonly event: "invocation_end";
			readonly ts: string;
			readonly outcome: string;
			readonly iterations: number;
			readonly totalUsage: IterationUsage;
			readonly totalCost: CostBreakdown;
	  };

/**
 * Append-only JSON-lines logger. ONE file per invocation —
 * timestamp+pid uniquely identifies the run. Opened by `openLog`
 * in `run.ts` before the iteration loop and closed in a `finally`.
 *
 * Crashes mid-line write are tolerable: the file is line-delimited,
 * so a half-written tail is the only loss.
 */
export type StructuredLog = {
	write(event: LogEvent): void;
	close(): Promise<void>;
	/** Path the log is being written to (useful for "see logs at..." outro). */
	readonly path: string;
};

export type OpenLogOptions = {
	/**
	 * Directory under the project root where logs are written.
	 * Defaults to `.ralph/logs`. Created with `mkdir -p` if missing.
	 */
	readonly dir?: string;
	/**
	 * Override the timestamp source — tests pin this to keep
	 * filenames deterministic.
	 */
	readonly now?: () => Date;
	/** Override the pid — tests use a fixed value for determinism. */
	readonly pid?: number;
};

/**
 * Open a fresh log file for an invocation. The directory is created
 * if missing. Filename format: `<YYYY-MM-DDTHH-MM-SS>-<pid>.log` —
 * colon-free so it's safe on Windows/macOS Finder.
 */
export function openLog(
	repoRoot: string,
	opts: OpenLogOptions = {},
): StructuredLog {
	const dir = join(repoRoot, opts.dir ?? ".ralph/logs");
	mkdirSync(dir, { recursive: true });

	const ts = (opts.now ?? (() => new Date()))()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace(/-\d{3}Z$/, "Z");
	const pid = opts.pid ?? process.pid;
	const path = join(dir, `${ts}-${pid}.log`);
	const stream: WriteStream = createWriteStream(path, {
		flags: "a",
		encoding: "utf8",
	});

	return {
		path,
		write(event: LogEvent): void {
			// `${JSON.stringify(event)}\n` — one JSON object per line so
			// the file is jq-parseable line by line and survives partial
			// writes.
			stream.write(`${JSON.stringify(event)}\n`);
		},
		close(): Promise<void> {
			return new Promise((resolve, reject) => {
				stream.end((err: Error | null | undefined) => {
					if (err !== null && err !== undefined) reject(err);
					else resolve();
				});
			});
		},
	};
}

/** Helper for callers — wraps `new Date().toISOString()` so events can be deterministic in tests. */
export function nowIso(now: () => Date = () => new Date()): string {
	return now().toISOString();
}
