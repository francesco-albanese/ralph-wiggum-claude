import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunState, StateStore } from "./state.js";

const ZERO_TOKENS = {
	inputTokens: 0,
	outputTokens: 0,
	cacheCreateTokens: 0,
	cacheReadTokens: 0,
};

function makeState(pid: number): RunState {
	return {
		pid,
		branch: "feat/detached",
		agent: "claude",
		model: "sonnet",
		startedAt: `2026-05-25T00:00:0${pid % 10}.000Z`,
		iteration: 0,
		currentBead: null,
		tasksDone: [],
		tokens: ZERO_TOKENS,
		costUsd: 0,
		logPath: `/tmp/${pid}.log`,
		prUrl: "",
	};
}

describe("StateStore", () => {
	let root: string;
	let store: StateStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ralph-state-"));
		store = new StateStore(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("writes state atomically to .ralph/state/<pid>.json", () => {
		store.write(makeState(123));
		store.write({ ...makeState(123), iteration: 2 });

		const path = store.pathFor(123);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			pid: 123,
			iteration: 2,
		});
		expect(
			readdirSync(join(root, ".ralph/state")).filter((f) => f.endsWith(".tmp")),
		).toEqual([]);
	});

	it("lists states sorted by start time", () => {
		store.write(makeState(2));
		store.write(makeState(1));

		expect(store.list().map((state) => state.pid)).toEqual([1, 2]);
	});

	it("cleans stale pid files and returns active runs", () => {
		store.write(makeState(1));
		store.write(makeState(2));

		const active = store.cleanupStale((pid) => pid === 2);

		expect(active.map((state) => state.pid)).toEqual([2]);
		expect(existsSync(store.pathFor(1))).toBe(false);
		expect(existsSync(store.pathFor(2))).toBe(true);
	});
});
