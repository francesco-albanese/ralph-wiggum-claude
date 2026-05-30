import { describe, expect, it } from "vitest";
import type {
	AgentProvider,
	BuildPrintCommandOptions,
	PrintCommand,
} from "../providers.js";
import { spawnAgent } from "./runtime.js";

/**
 * Minimal provider whose `buildPrintCommand` records the options it was
 * called with and returns a harmless command (`true` exits 0 immediately),
 * so the test never launches a real agent.
 */
function recordingProvider(
	onBuild: (options?: BuildPrintCommandOptions) => void,
): AgentProvider {
	return {
		name: "claude",
		env: {},
		qualityGateCommand: "/quality-gate",
		buildPrintCommand(options?: BuildPrintCommandOptions): PrintCommand {
			onBuild(options);
			// `node -e ""` is a no-op that exits 0 on every platform (unlike
			// `true`, which isn't guaranteed on Windows).
			return { cmd: process.execPath, args: ["-e", ""], env: {} };
		},
		parseStreamLine() {
			return [];
		},
	};
}

describe("spawnAgent", () => {
	// Regression guard for the bug where the run loop spawned `claude --print`
	// with no prompt, so the agent errored on empty input and produced nothing.
	it("forwards the rendered prompt to buildPrintCommand", () => {
		let received: BuildPrintCommandOptions | undefined;
		const provider = recordingProvider((options) => {
			received = options;
		});

		const child = spawnAgent({
			cwd: process.cwd(),
			signal: new AbortController().signal,
			forceSignal: new AbortController().signal,
			provider,
			prompt: "the rendered prompt",
		});
		child.kill();

		expect(received).toEqual({ prompt: "the rendered prompt" });
	});
});
