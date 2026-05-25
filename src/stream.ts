import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * Per-iteration token-usage counts, derived from each agent's
 * stream-JSON. NEVER from a separate API call.
 *
 * Field names match Claude Code's `message.usage` shape, normalised
 * to camelCase for our own surface.
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
			readonly kind: "init";
			/** Model id reported by the agent (e.g. "claude-opus-4-7"). */
			readonly model: string;
	  }
	| {
			readonly kind: "text";
			/** Streamed prose chunk from the assistant. */
			readonly text: string;
	  }
	| {
			readonly kind: "tool";
			/** Tool name (e.g. "Bash", "Read", "Edit"). */
			readonly name: string;
			/** Raw tool input — shape varies per tool. */
			readonly input: unknown;
	  }
	| {
			readonly kind: "usage";
			/** Token counts for this iteration so far (cumulative within the agent). */
			readonly usage: IterationUsage;
			/** Model the usage applies to, if the agent reported one. */
			readonly model?: string;
	  };

/**
 * Walking-skeleton stream-JSON parser for Claude Code's
 * `--output-format stream-json --verbose` output.
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
): Promise<void> {
	for await (const event of streamAgentEvents(stdout)) {
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
 * Token-usage events are surfaced from BOTH `assistant` messages
 * (mid-stream) and the terminal `result` event — the latter is the
 * authoritative final usage for the iteration.
 */
export async function* streamAgentEvents(
	stdout: Readable,
): AsyncGenerator<ParsedStreamEvent, void, void> {
	const rl = createInterface({
		input: stdout,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}

		yield* parseEvent(event);
	}
}

function* parseEvent(event: unknown): Generator<ParsedStreamEvent, void, void> {
	if (!isRecord(event)) return;

	const type = event.type;

	if (type === "system" && event.subtype === "init") {
		const model = typeof event.model === "string" ? event.model : undefined;
		if (model !== undefined) yield { kind: "init", model };
		return;
	}

	if (type === "assistant") {
		const message = event.message;
		if (!isRecord(message)) return;

		const content = message.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!isRecord(block)) continue;
				if (block.type === "text" && typeof block.text === "string") {
					yield { kind: "text", text: block.text };
				} else if (block.type === "tool_use") {
					const name = typeof block.name === "string" ? block.name : "tool";
					yield { kind: "tool", name, input: block.input };
				}
			}
		}

		// NB: we intentionally DO NOT surface usage from `assistant`
		// events. Claude Code emits per-message usage there which would
		// double-count against the authoritative final `result.usage`
		// event. Cost is computed from `result` only.
		//
		// Trade-off: if the agent crashes/times out before emitting
		// `result`, the iteration's cost is reported as $0. We accept
		// that — surfacing a partial assistant.usage snapshot as the
		// "real" cost would be MORE misleading, and the structured
		// log keeps every parsed event raw so a forensic reader can
		// still recover the partial totals. See stream.test.ts for
		// both the realistic-capture and inverse-fixture regression
		// tests.
		return;
	}

	if (type === "result") {
		// Terminal event — Claude Code reports the authoritative
		// final usage here. The ONLY usage source we trust so the
		// per-iteration totals are correct end-to-end.
		const usage = parseUsage(event.usage);
		if (usage !== undefined) {
			const model = typeof event.model === "string" ? event.model : undefined;
			yield model !== undefined
				? { kind: "usage", usage, model }
				: { kind: "usage", usage };
		}
	}
}

function parseUsage(raw: unknown): IterationUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const inputTokens = numberOr(raw.input_tokens, 0);
	const outputTokens = numberOr(raw.output_tokens, 0);
	const cacheCreateTokens = numberOr(raw.cache_creation_input_tokens, 0);
	const cacheReadTokens = numberOr(raw.cache_read_input_tokens, 0);
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		cacheCreateTokens === 0 &&
		cacheReadTokens === 0
	) {
		// All zero — likely a placeholder; not useful to surface.
		return undefined;
	}
	return { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens };
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
