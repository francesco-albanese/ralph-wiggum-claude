import { type ChildProcess, spawn } from "node:child_process";
import { parseBranch } from "../branch.js";
import { runProc } from "../proc.js";
import type { AgentProvider, PrintCommand } from "../providers.js";
import { type Worktree, WorktreeManager } from "../worktree.js";

export type AgentContext = {
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly forceSignal: AbortSignal;
};

export type AgentRunner = (ctx: AgentContext) => Promise<void>;

export type RunInWorktreeOptions = {
	readonly branch: string;
	readonly repoRoot: string;
	readonly agent: AgentRunner;
	readonly signal?: AbortSignal;
	readonly forceSignal?: AbortSignal;
};

export async function runInWorktree(opts: RunInWorktreeOptions): Promise<void> {
	const branch = parseBranch(opts.branch);
	const mgr = new WorktreeManager({ repoRoot: opts.repoRoot });

	let wt: Worktree | undefined;
	try {
		wt = await mgr.create(branch);

		const signal = opts.signal ?? new AbortController().signal;
		const forceSignal = opts.forceSignal ?? new AbortController().signal;
		if (signal.aborted) return;

		await opts.agent({ cwd: wt.path, signal, forceSignal });
	} finally {
		if (wt !== undefined) {
			await mgr.remove(wt);
		}
	}
}

export type GracefulShutdown = {
	readonly signal: AbortSignal;
	readonly forceSignal: AbortSignal;
	readonly dispose: () => void;
};

export type GracefulShutdownOptions = {
	readonly drainMs?: number;
	readonly secondPressMs?: number;
	readonly out?: NodeJS.WritableStream;
};

const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_SECOND_PRESS_MS = 5_000;

export function installGracefulShutdown(
	opts: GracefulShutdownOptions = {},
): GracefulShutdown {
	const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
	const secondPressMs = opts.secondPressMs ?? DEFAULT_SECOND_PRESS_MS;
	const out = opts.out ?? process.stderr;

	const ac = new AbortController();
	const forceAc = new AbortController();

	let firstSignalAt = 0;
	let drainTimer: NodeJS.Timeout | null = null;
	let secondPressTimer: NodeJS.Timeout | null = null;
	let disposed = false;

	const writeLine = (line: string) => {
		out.write(`${line}\n`);
	};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		if (drainTimer !== null) clearTimeout(drainTimer);
		if (secondPressTimer !== null) clearTimeout(secondPressTimer);
		drainTimer = null;
		secondPressTimer = null;
	};

	const escalate = (reason: string) => {
		if (forceAc.signal.aborted) return;
		writeLine(`ralph: ${reason}, escalating to force-kill...`);
		forceAc.abort();
	};

	const onSignal = (sig: NodeJS.Signals) => {
		const now = Date.now();
		if (firstSignalAt === 0) {
			firstSignalAt = now;
			writeLine(
				`\nralph: received ${sig}, draining for up to ${Math.round(
					drainMs / 1000,
				)}s (press Ctrl-C again to force-kill)...`,
			);
			ac.abort();
			drainTimer = setTimeout(
				() => escalate(`drain timeout (${Math.round(drainMs / 1000)}s)`),
				drainMs,
			);
			drainTimer.unref?.();
			secondPressTimer = setTimeout(() => {
				secondPressTimer = null;
			}, secondPressMs);
			secondPressTimer.unref?.();
		} else if (
			secondPressTimer !== null &&
			now - firstSignalAt <= secondPressMs
		) {
			escalate(`second ${sig} within ${Math.round(secondPressMs / 1000)}s`);
		}
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	return { signal: ac.signal, forceSignal: forceAc.signal, dispose };
}

export async function hostEnsureCleanWorktree(): Promise<void> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["status", "--porcelain"],
	});
	if (stdout.trim().length > 0) {
		throw new Error(
			"working tree is not clean; commit or stash changes before running ralph",
		);
	}
}

export async function hostCaptureBaseBranch(): Promise<string> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["branch", "--show-current"],
	});
	const base = stdout.trim();
	if (base.length === 0) {
		throw new Error("could not determine current branch (detached HEAD?)");
	}
	return base;
}

export async function captureRepoRoot(): Promise<string> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["worktree", "list", "--porcelain"],
	});
	const firstLine = stdout.split(/\r?\n/, 1)[0] ?? "";
	const match = firstLine.match(/^worktree (.+)$/);
	const root = match?.[1];
	if (root === undefined) {
		throw new Error(
			"could not resolve git repo root from `git worktree list`; is the current directory inside a git repo?",
		);
	}
	return root;
}

export function spawnAgent(
	ctx: AgentContext & { readonly provider: AgentProvider },
): ChildProcess {
	const command = ctx.provider.buildPrintCommand();
	const child = spawn(command.cmd, [...command.args], {
		cwd: ctx.cwd,
		stdio: ["inherit", "pipe", "inherit"],
		env: buildAgentEnvironment(command),
	});

	const onTerm = () => {
		child.kill("SIGTERM");
	};
	const onKill = () => {
		child.kill("SIGKILL");
	};

	if (ctx.signal.aborted) onTerm();
	else ctx.signal.addEventListener("abort", onTerm, { once: true });

	if (ctx.forceSignal.aborted) onKill();
	else ctx.forceSignal.addEventListener("abort", onKill, { once: true });

	child.once("close", () => {
		ctx.signal.removeEventListener("abort", onTerm);
		ctx.forceSignal.removeEventListener("abort", onKill);
	});

	return child;
}

function buildAgentEnvironment(command: PrintCommand): NodeJS.ProcessEnv {
	const nodeEnv = Reflect.get(process, "env") as NodeJS.ProcessEnv;
	const agentEnv = Reflect.get(command, "env") as PrintCommand["env"];
	return { ...nodeEnv, ...agentEnv };
}

export async function defaultCommitsAhead(
	cwd: string,
	base: string,
): Promise<number> {
	const { stdout } = await runProc({
		cmd: "git",
		args: ["rev-list", `${base}..HEAD`, "--count"],
		cwd,
	});
	const n = Number.parseInt(stdout.trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

export async function defaultPushBranch(
	cwd: string,
	branch: string,
): Promise<void> {
	await runProc({
		cmd: "git",
		args: ["push", "-u", "origin", branch],
		cwd,
	});
}

export async function defaultCreateDraftPr(
	cwd: string,
	args: { base: string; head: string },
): Promise<string> {
	const { stdout } = await runProc({
		cmd: "gh",
		args: [
			"pr",
			"create",
			"--draft",
			"--base",
			args.base,
			"--head",
			args.head,
			"--fill",
		],
		cwd,
	});
	return stdout.trim();
}

export async function defaultMarkPrReady(
	cwd: string,
	url: string,
): Promise<void> {
	await runProc({ cmd: "gh", args: ["pr", "ready", url], cwd });
}
