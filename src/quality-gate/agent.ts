import { spawn } from "node:child_process";
import type { AgentProvider } from "../providers.js";
import { streamAgentText } from "../stream.js";

const QG_AGENT_TIMEOUT_MS = 30 * 60_000;
const QG_HARD_KILL_GRACE_MS = 5_000;

export type QualityGateAgentCommand = {
	readonly cmd: string;
	readonly args: readonly string[];
};

export function buildQualityGateAgentCommand(
	provider: AgentProvider,
): QualityGateAgentCommand {
	const command = provider.buildPrintCommand();
	return { cmd: command.cmd, args: command.args };
}

export function spawnQualityGateAgent(args: {
	readonly cwd: string;
	readonly prompt: string;
	readonly provider: AgentProvider;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const command = buildQualityGateAgentCommand(args.provider);
		const child = spawn(command.cmd, [...command.args], {
			cwd: args.cwd,
			stdio: ["pipe", "pipe", "inherit"],
		});
		child.stdin?.end(args.prompt);

		const stdout = child.stdout;
		if (stdout === null) {
			reject(new Error("quality gate agent produced no stdout"));
			return;
		}

		let collected = "";
		let settled = false;
		let timedOut = false;
		let timer: NodeJS.Timeout | null = null;
		let hardKillTimer: NodeJS.Timeout | null = null;

		const clearTimers = () => {
			if (timer !== null) clearTimeout(timer);
			if (hardKillTimer !== null) clearTimeout(hardKillTimer);
		};
		const safeResolve = (value: string) => {
			if (settled) return;
			settled = true;
			clearTimers();
			resolve(value);
		};
		const safeReject = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimers();
			reject(err);
		};

		timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			hardKillTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, QG_HARD_KILL_GRACE_MS);
		}, QG_AGENT_TIMEOUT_MS);

		const sink: NodeJS.WritableStream = {
			write(chunk: string | Uint8Array): boolean {
				const text =
					typeof chunk === "string"
						? chunk
						: Buffer.from(chunk).toString("utf8");
				collected += text;
				process.stdout.write(text);
				return true;
			},
			end(): void {
				/* no-op */
			},
		} as unknown as NodeJS.WritableStream;

		const streaming = streamAgentText(stdout, sink, args.provider);

		child.on("error", safeReject);
		child.on("close", (code, signal) => {
			streaming
				.then(() => {
					if (timedOut) {
						safeReject(
							new Error(
								`quality gate agent timed out after ${Math.round(
									QG_AGENT_TIMEOUT_MS / 60_000,
								)} minutes`,
							),
						);
						return;
					}
					if (signal !== null) {
						safeReject(
							new Error(`quality gate agent terminated by signal ${signal}`),
						);
						return;
					}
					if (code !== 0 && code !== null) {
						safeReject(
							new Error(`quality gate agent exited with code ${code}`),
						);
						return;
					}
					safeResolve(collected);
				})
				.catch(safeReject);
		});
	});
}
