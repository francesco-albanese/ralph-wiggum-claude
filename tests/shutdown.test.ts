import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type GracefulShutdownOptions,
	installGracefulShutdown,
} from "../src/run.js";

function listenerCount(sig: "SIGINT" | "SIGTERM"): number {
	return process.listenerCount(sig);
}

function tick(ms = 0): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// Silent sink so the shutdown banner doesn't spam vitest's stderr.
const SILENT: NodeJS.WritableStream = {
	write: () => true,
	end: () => {},
} as unknown as NodeJS.WritableStream;

function install(opts: GracefulShutdownOptions = {}) {
	return installGracefulShutdown({ out: SILENT, ...opts });
}

describe("installGracefulShutdown", () => {
	let baselineSigint: number;
	let baselineSigterm: number;

	beforeEach(() => {
		baselineSigint = listenerCount("SIGINT");
		baselineSigterm = listenerCount("SIGTERM");
	});

	// Belt-and-braces: even if a test fails mid-flight, the next test
	// starts from a known good baseline.
	afterEach(() => {
		while (listenerCount("SIGINT") > baselineSigint) {
			const listeners = process.listeners("SIGINT");
			const extra = listeners[listeners.length - 1];
			if (extra !== undefined) process.off("SIGINT", extra);
		}
		while (listenerCount("SIGTERM") > baselineSigterm) {
			const listeners = process.listeners("SIGTERM");
			const extra = listeners[listeners.length - 1];
			if (extra !== undefined) process.off("SIGTERM", extra);
		}
	});

	it("registers SIGINT and SIGTERM listeners on install and removes them on dispose (clean-exit path)", () => {
		// Regression guard for the listener-leak bug: a clean ralph run
		// must NOT leave SIGINT/SIGTERM listeners attached. The fix is
		// the `finally { dispose() }` in runCommand; this test pins it.
		const shutdown = install();
		expect(listenerCount("SIGINT")).toBe(baselineSigint + 1);
		expect(listenerCount("SIGTERM")).toBe(baselineSigterm + 1);

		shutdown.dispose();
		expect(listenerCount("SIGINT")).toBe(baselineSigint);
		expect(listenerCount("SIGTERM")).toBe(baselineSigterm);
	});

	it("dispose is idempotent", () => {
		const shutdown = install();
		shutdown.dispose();
		expect(() => shutdown.dispose()).not.toThrow();
		expect(listenerCount("SIGINT")).toBe(baselineSigint);
	});

	it("first signal aborts `signal` but leaves `forceSignal` alone", async () => {
		const shutdown = install({
			drainMs: 60_000,
			secondPressMs: 60_000,
		});
		try {
			expect(shutdown.signal.aborted).toBe(false);
			expect(shutdown.forceSignal.aborted).toBe(false);

			process.emit("SIGINT", "SIGINT");
			await tick();

			expect(shutdown.signal.aborted).toBe(true);
			expect(shutdown.forceSignal.aborted).toBe(false);
		} finally {
			shutdown.dispose();
		}
	});

	it("second signal within the press window aborts `forceSignal`", async () => {
		const shutdown = install({
			drainMs: 60_000,
			secondPressMs: 60_000,
		});
		try {
			process.emit("SIGINT", "SIGINT");
			await tick();
			process.emit("SIGINT", "SIGINT");
			await tick();

			expect(shutdown.signal.aborted).toBe(true);
			expect(shutdown.forceSignal.aborted).toBe(true);
		} finally {
			shutdown.dispose();
		}
	});

	it("drain timeout escalates to `forceSignal` even without a second press", async () => {
		const shutdown = install({
			drainMs: 25,
			secondPressMs: 60_000,
		});
		try {
			process.emit("SIGINT", "SIGINT");
			await tick(60);

			expect(shutdown.signal.aborted).toBe(true);
			expect(shutdown.forceSignal.aborted).toBe(true);
		} finally {
			shutdown.dispose();
		}
	});

	it("a second signal AFTER the press window does NOT escalate", async () => {
		const shutdown = install({
			drainMs: 60_000,
			secondPressMs: 20,
		});
		try {
			process.emit("SIGINT", "SIGINT");
			await tick(40);
			process.emit("SIGINT", "SIGINT");
			await tick();

			expect(shutdown.signal.aborted).toBe(true);
			expect(shutdown.forceSignal.aborted).toBe(false);
		} finally {
			shutdown.dispose();
		}
	});
});
