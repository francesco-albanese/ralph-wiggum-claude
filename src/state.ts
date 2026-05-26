import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentName } from "./config/schema.js";
import type { IterationUsage } from "./stream.js";

export type RunState = {
	readonly pid: number;
	readonly branch: string;
	readonly agent: AgentName;
	readonly model: string;
	readonly startedAt: string;
	readonly iteration: number;
	readonly currentBead: string | null;
	readonly tasksDone: readonly string[];
	readonly tokens: IterationUsage;
	readonly costUsd: number;
	readonly logPath: string;
	readonly prUrl: string;
};

export class StateStore {
	readonly dir: string;

	constructor(repoRoot: string, dir = join(repoRoot, ".ralph/state")) {
		this.dir = dir;
	}

	pathFor(pid: number): string {
		return join(this.dir, `${pid}.json`);
	}

	write(state: RunState): void {
		mkdirSync(this.dir, { recursive: true });
		const path = this.pathFor(state.pid);
		const tmp = join(
			dirname(path),
			`.${state.pid}.${process.pid}.${Date.now()}.tmp`,
		);
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	}

	remove(pid: number): void {
		if (!Number.isInteger(pid) || pid <= 0) return;
		rmSync(this.pathFor(pid), { force: true });
	}

	list(): RunState[] {
		let files: string[];
		try {
			files = readdirSync(this.dir);
		} catch {
			return [];
		}
		return files
			.filter((file) => file.endsWith(".json"))
			.flatMap((file) => {
				try {
					const parsed = JSON.parse(readFileSync(join(this.dir, file), "utf8"));
					return isRunState(parsed) ? [parsed] : [];
				} catch {
					return [];
				}
			})
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}

	cleanupStale(isAlive = processIsAlive): RunState[] {
		const active: RunState[] = [];
		for (const state of this.list()) {
			if (isAlive(state.pid)) active.push(state);
			else this.remove(state.pid);
		}
		return active;
	}
}

function isRunState(value: unknown): value is RunState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<RunState>;
	return (
		Number.isInteger(state.pid) &&
		(state.pid ?? 0) > 0 &&
		typeof state.branch === "string" &&
		typeof state.agent === "string" &&
		typeof state.model === "string" &&
		typeof state.startedAt === "string" &&
		Number.isInteger(state.iteration) &&
		typeof state.costUsd === "number" &&
		typeof state.logPath === "string" &&
		typeof state.prUrl === "string" &&
		isTokens(state.tokens)
	);
}

function isTokens(value: unknown): value is RunState["tokens"] {
	if (typeof value !== "object" || value === null) return false;
	const tokens = value as Partial<RunState["tokens"]>;
	return (
		typeof tokens.inputTokens === "number" &&
		typeof tokens.outputTokens === "number" &&
		typeof tokens.cacheCreateTokens === "number" &&
		typeof tokens.cacheReadTokens === "number"
	);
}

export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code =
			typeof err === "object" && err !== null && "code" in err
				? String(err.code)
				: "";
		return code === "EPERM";
	}
}
