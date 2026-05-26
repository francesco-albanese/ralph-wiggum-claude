import { spawn } from "node:child_process";
import {
	closeSync,
	createReadStream,
	mkdirSync,
	openSync,
	statSync,
	watch,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { captureRepoRoot, type RunOptions } from "./run.js";
import { type RunState, StateStore } from "./state.js";

export type DetachedResult = {
	readonly pid: number;
	readonly logPath: string;
};

export async function runDetachedCommand(
	_opts: RunOptions,
	args = process.argv,
): Promise<DetachedResult> {
	const repoRoot = await captureRepoRoot();
	const logPath = makeDetachedLogPath(repoRoot);
	mkdirSync(join(repoRoot, ".ralph/logs"), { recursive: true });
	const logFd = openSync(logPath, "a");
	const child = spawn(process.execPath, buildChildArgs(args), {
		cwd: process.cwd(),
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: {
			...nodeEnv(),
			RALPH_DETACHED_STATE: "1",
			RALPH_DETACHED_LOG_PATH: logPath,
		},
	});
	closeSync(logFd);
	child.unref();
	return { pid: child.pid ?? 0, logPath };
}

export async function statusCommand(
	out: NodeJS.WritableStream = process.stdout,
): Promise<void> {
	const repoRoot = await captureRepoRoot();
	const runs = new StateStore(repoRoot).cleanupStale();
	if (runs.length === 0) {
		out.write("No active ralph runs\n");
		return;
	}
	for (const state of runs) out.write(`${formatState(state)}\n`);
}

export async function stopCommand(pid?: number): Promise<RunState> {
	const repoRoot = await captureRepoRoot();
	const state = selectRun(new StateStore(repoRoot).cleanupStale(), pid);
	process.kill(state.pid, "SIGTERM");
	return state;
}

export async function tailCommand(
	pid?: number,
	out: NodeJS.WritableStream = process.stdout,
): Promise<void> {
	const repoRoot = await captureRepoRoot();
	const state = selectRun(new StateStore(repoRoot).cleanupStale(), pid, true);
	const signal = signalFromSigint();
	await followFile(state.logPath, out, signal);
}

export function selectRun(
	runs: readonly RunState[],
	pid?: number,
	allowMostRecent = false,
): RunState {
	if (pid !== undefined) {
		const state = runs.find((run) => run.pid === pid);
		if (state === undefined)
			throw new Error(`no active ralph run for pid ${pid}`);
		return state;
	}
	if (runs.length === 0) throw new Error("no active ralph runs");
	if (runs.length === 1 || allowMostRecent) return [...runs].at(-1) as RunState;
	throw new Error("multiple active ralph runs; pass a pid");
}

function buildChildArgs(args: readonly string[]): string[] {
	const [entry, ...rest] = args.slice(1);
	return [entry ?? "", ...rest.filter((arg) => arg !== "--detach")].filter(
		(arg) => arg.length > 0,
	);
}

function makeDetachedLogPath(repoRoot: string): string {
	const ts = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace(/-\d{3}Z$/, "Z");
	return join(repoRoot, ".ralph/logs", `${ts}-detached.log`);
}

function formatState(state: RunState): string {
	return [
		`pid=${state.pid}`,
		`branch=${state.branch}`,
		`agent=${state.agent}`,
		`model=${state.model || DEFAULT_CONFIG.defaultModel}`,
		`iter=${state.iteration}`,
		`tokens=${state.tokens.inputTokens + state.tokens.outputTokens}`,
		`cost=$${state.costUsd.toFixed(4)}`,
		`log=${state.logPath}`,
	].join(" ");
}

export async function followFile(
	path: string,
	out: NodeJS.WritableStream,
	signal?: AbortSignal,
): Promise<void> {
	let offset = 0;
	const pump = () => {
		const size = statSync(path).size;
		if (size <= offset) return;
		const stream = createReadStream(path, { start: offset, end: size - 1 });
		offset = size;
		stream.pipe(out, { end: false });
	};
	pump();
	await new Promise<void>((resolve) => {
		const watcher = watch(path, pump);
		const done = () => {
			watcher.close();
			resolve();
		};
		if (signal?.aborted) done();
		else signal?.addEventListener("abort", done, { once: true });
	});
}

function nodeEnv(): NodeJS.ProcessEnv {
	return Reflect.get(process, "env") as NodeJS.ProcessEnv;
}

function signalFromSigint(): AbortSignal {
	const ac = new AbortController();
	process.once("SIGINT", () => ac.abort());
	return ac.signal;
}
