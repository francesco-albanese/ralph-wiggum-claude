import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { type AgentProvider, claude } from "./providers.js";

/**
 * Per-iteration token-usage counts, derived from each agent's
 * stream-JSON. NEVER from a separate API call.
 *
 * Field names match provider token usage shapes, normalised to
 * camelCase for our own surface.
 */
export type IterationUsage = {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheCreateTokens: number;
	readonly cacheReadTokens: number;
};

/**
 * Normalised event union emitted by `streamAgentEvents`. We surface
 * only the parts of Claude Code's stream-JSON that downstream
 * consumers (display, cost, log) actually care about — everything
 * else (status pings, tool_result echoes) is dropped.
 */
export type ParsedStreamEvent =
	| {
			readonly kind: "session_id";
			/** Agent session/thread id, when reported. */
			readonly sessionId?: string;
			/** Model id reported by the agent (e.g. "claude-opus-4-7"). */
			readonly model?: string;
	  }
	| {
			readonly kind: "text";
			/** Streamed prose chunk from the assistant. */
			readonly text: string;
	  }
	| {
			readonly kind: "tool_call";
			/** Tool name (e.g. "Bash", "Read", "Edit"). */
			readonly name: string;
			/** Raw tool input — shape varies per tool. */
			readonly input: unknown;
	  }
	| {
			readonly kind: "result";
			/** Token counts for this iteration so far (cumulative within the agent). */
			readonly usage: IterationUsage;
			/** Model the usage applies to, if the agent reported one. */
			readonly model?: string;
	  };

const DEFAULT_PROVIDER = claude(DEFAULT_CONFIG.defaultModel);

/**
 * Walking-skeleton stream-JSON parser for agent stream-JSON output.
 *
 * Claude emits one JSON object per line. We only care about
 * `assistant` events and within those only `text` content
 * blocks — tool calls and everything else are deliberately ignored
 * for this slice.
 *
 * Non-JSON lines (status noise) are swallowed.
 *
 * Retained alongside `streamAgentEvents` so existing call sites
 * (e.g. `runIteration`) keep working without refactor.
 */
export async function streamAgentText(
	stdout: Readable,
	out: NodeJS.WritableStream,
	provider: AgentProvider = DEFAULT_PROVIDER,
): Promise<void> {
	for await (const event of streamAgentEvents(stdout, provider)) {
		if (event.kind === "text") {
			out.write(event.text);
		}
	}
}

/**
 * Async iterator over the normalised `ParsedStreamEvent`s extracted
 * from Claude Code's stream-JSON. Consumers (display, cost calculator,
 * structured log) subscribe by `for await`-ing this once per agent
 * subprocess.
 *
 * Non-JSON lines and uninteresting event types are silently dropped.
 * Token-usage events are surfaced only from terminal events:
 * Claude Code's `result` or OpenAI Responses' `response.completed`.
 * Those are the authoritative final usage for the iteration.
 * Intermediate `assistant.message.usage` snapshots are intentionally
 * ignored to avoid double-counting.
 */
export async function* streamAgentEvents(
	stdout: Readable,
	provider: AgentProvider = DEFAULT_PROVIDER,
): AsyncGenerator<ParsedStreamEvent, void, void> {
	const rl = createInterface({
		input: stdout,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		yield* provider.parseStreamLine(line);
	}
}
