import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runIteration } from "./iteration.js";

/**
 * Tiny fake of the bits of `ChildProcess` that runIteration uses,
 * so we never need to spawn a real subprocess in tests.
 */
interface FakeChild extends EventEmitter {
	stdout: Readable;
	kill: (sig?: NodeJS.Signals) => boolean;
}

function makeFakeChild(): FakeChild & {
	emitStdout(chunk: string): void;
	finish(code: number): void;
	wasKilled(): boolean;
} {
	const emitter = new EventEmitter() as FakeChild & {
		emitStdout(chunk: string): void;
		finish(code: number): void;
		wasKilled(): boolean;
	};
	const stdout = new PassThrough();
	emitter.stdout = stdout;
	let killed = false;
	emitter.kill = (_sig?: NodeJS.Signals) => {
		killed = true;
		return true;
	};
	emitter.emitStdout = (chunk: string) => {
		stdout.write(chunk);
	};
	emitter.finish = (code: number) => {
		stdout.end();
		emitter.emit("close", code);
	};
	emitter.wasKilled = () => killed;
	return emitter;
}

const asChild = (
	c: FakeChild & {
		emitStdout(chunk: string): void;
		finish(code: number): void;
		wasKilled(): boolean;
	},
) => c as unknown as ChildProcess;

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
		const child = makeFakeChild();
		const result = runIteration({
			spawn: () => asChild(child),
			out: new PassThrough(),
			timeoutMs: 60,
		});

		vi.advanceTimersByTime(61);
		// The implementation must have asked the child to die.
		expect(child.wasKilled()).toBe(true);
		// Simulate the SIGTERM propagating: process exits with non-zero.
		child.finish(143);

		await expect(result).resolves.toMatchObject({ outcome: "timed-out" });
		vi.useRealTimers();
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
});
