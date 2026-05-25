import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runIteration } from "./iteration.js";
import { codex } from "./providers.js";

/**
 * Tiny fake of the bits of `ChildProcess` that runIteration uses,
 * so we never need to spawn a real subprocess in tests.
 */
interface FakeChild extends EventEmitter {
	stdout: Readable;
	kill: (sig?: NodeJS.Signals) => boolean;
}

type FakeChildExt = FakeChild & {
	emitStdout(chunk: string): void;
	finish(code: number | null, signal?: NodeJS.Signals): void;
	wasKilled(): boolean;
	killSignals(): readonly NodeJS.Signals[];
};

interface FakeChildOptions {
	/** If true, `kill()` returns false (process refuses to die). */
	readonly ignoreKill?: boolean;
}

function makeFakeChild(opts: FakeChildOptions = {}): FakeChildExt {
	const emitter = new EventEmitter() as FakeChildExt;
	const stdout = new PassThrough();
	emitter.stdout = stdout;
	const signals: NodeJS.Signals[] = [];
	emitter.kill = (sig?: NodeJS.Signals) => {
		signals.push(sig ?? "SIGTERM");
		return !opts.ignoreKill;
	};
	emitter.emitStdout = (chunk: string) => {
		stdout.write(chunk);
	};
	emitter.finish = (code: number | null, signal?: NodeJS.Signals) => {
		stdout.end();
		emitter.emit("close", code, signal ?? null);
	};
	emitter.wasKilled = () => signals.length > 0;
	emitter.killSignals = () => signals;
	return emitter;
}

const asChild = (c: FakeChildExt) => c as unknown as ChildProcess;

describe("runIteration", () => {
	it("returns outcome 'continue' when the agent exits 0 without the signal", async () => {
		const child = makeFakeChild();
		const result = runIteration({
			spawn: () => asChild(child),
			out: new PassThrough(),
		});
		child.emitStdout("doing things\n");
		child.finish(0);

		await expect(result).resolves.toMatchObject({ outcome: "continue" });
	});

	it("returns outcome 'crashed' when the agent exits non-zero", async () => {
		const child = makeFakeChild();
		const result = runIteration({
			spawn: () => asChild(child),
			out: new PassThrough(),
		});
		child.finish(1);

		await expect(result).resolves.toMatchObject({ outcome: "crashed" });
	});

	it("returns outcome 'complete' when the agent emits the completion signal", async () => {
		const child = makeFakeChild();
		const result = runIteration({
			spawn: () => asChild(child),
			out: new PassThrough(),
		});

		child.emitStdout(
			`${JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{
							type: "text",
							text: "all bd ready exhausted <promise>COMPLETE</promise>",
						},
					],
				},
			})}\n`,
		);
		child.finish(0);

		await expect(result).resolves.toMatchObject({ outcome: "complete" });
	});

	it("SIGTERMs the agent and resolves 'timed-out' after the per-iteration timeout", async () => {
		vi.useFakeTimers();
		try {
			const child = makeFakeChild();
			const result = runIteration({
				spawn: () => asChild(child),
				out: new PassThrough(),
				timeoutMs: 60,
			});

			vi.advanceTimersByTime(61);
			// The implementation must have asked the child to die.
			expect(child.wasKilled()).toBe(true);
			expect(child.killSignals()).toContain("SIGTERM");
			// Simulate the SIGTERM propagating: process exits with non-zero.
			child.finish(143, "SIGTERM");

			await expect(result).resolves.toMatchObject({ outcome: "timed-out" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("escalates to SIGKILL when the child ignores SIGTERM, and still resolves 'timed-out'", async () => {
		vi.useFakeTimers();
		try {
			const child = makeFakeChild({ ignoreKill: true });
			const result = runIteration({
				spawn: () => asChild(child),
				out: new PassThrough(),
				timeoutMs: 60,
				hardKillGraceMs: 100,
			});

			vi.advanceTimersByTime(61);
			expect(child.killSignals()).toEqual(["SIGTERM"]);

			// SIGTERM is swallowed. After the hard-kill grace, SIGKILL fires.
			vi.advanceTimersByTime(101);
			expect(child.killSignals()).toEqual(["SIGTERM", "SIGKILL"]);

			// Child STILL refuses to close (truly unkillable: D-state / zombie).
			// After the safety grace, runIteration resolves anyway so the loop
			// is not pinned forever on a hung child.
			vi.advanceTimersByTime(101);
			await expect(result).resolves.toMatchObject({
				outcome: "timed-out",
				exitCode: null,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns outcome 'signal-killed' when an external signal terminates the child without a timeout firing", async () => {
		const child = makeFakeChild();
		const result = runIteration({
			spawn: () => asChild(child),
			out: new PassThrough(),
		});

		// Parent process (or supervisor) sends SIGINT to the child; close
		// fires with code=null, signal="SIGINT". This must NOT be counted
		// as "crashed" — otherwise an external Ctrl-C would feed the
		// crash-rate stall.
		child.finish(null, "SIGINT");

		await expect(result).resolves.toMatchObject({
			outcome: "signal-killed",
			exitCode: null,
		});
	});

	it("honours a custom completion regex passed via --complete-signal", async () => {
		const child = makeFakeChild();
		const result = runIteration({
			spawn: () => asChild(child),
			out: new PassThrough(),
			completeSignal: /ALL DONE/,
		});
		child.emitStdout(
			`${JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "yes -- ALL DONE" }] },
			})}\n`,
		);
		child.finish(0);

		await expect(result).resolves.toMatchObject({ outcome: "complete" });
	});

	it("uses the supplied provider in the default stream consumer path", async () => {
		const child = makeFakeChild();
		const out = new PassThrough();
		const chunks: string[] = [];
		out.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
		const result = runIteration({
			spawn: () => asChild(child),
			out,
			provider: codex("gpt-5.3-codex"),
		});

		child.emitStdout(
			`${JSON.stringify({
				type: "response.output_text.delta",
				delta: "done from codex",
			})}\n`,
		);
		child.finish(0);

		await expect(result).resolves.toMatchObject({ outcome: "continue" });
		expect(chunks.join("")).toContain("done from codex");
	});
});
