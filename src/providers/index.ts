import type { AgentName } from "../config/schema.js";
import type { IterationUsage, ParsedStreamEvent } from "../stream.js";

export type PrintCommand = {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
};

export type BuildPrintCommandOptions = {
	readonly prompt?: string;
};

export interface AgentProvider {
	readonly name: AgentName;
	readonly env: Readonly<Record<string, string>>;
	readonly qualityGateCommand: string;
	buildPrintCommand(options?: BuildPrintCommandOptions): PrintCommand;
	parseStreamLine(line: string): readonly ParsedStreamEvent[];
	parseSessionUsage?(content: unknown): IterationUsage | undefined;
}

export function claude(model: string): AgentProvider {
	const providerEnv = {};
	return {
		name: "claude",
		env: providerEnv,
		qualityGateCommand: "/quality-gate",
		buildPrintCommand(options: BuildPrintCommandOptions = {}): PrintCommand {
			return {
				cmd: "claude",
				args: [
					"-p",
					"--output-format",
					"stream-json",
					"--verbose",
					"--dangerously-skip-permissions",
					"--model",
					model,
					...(options.prompt !== undefined ? [options.prompt] : []),
				],
				env: providerEnv,
			};
		},
		parseStreamLine(line: string): readonly ParsedStreamEvent[] {
			const event = parseJsonLine(line);
			return event === undefined ? [] : parseClaudeEvent(event);
		},
		parseSessionUsage: parseClaudeUsage,
	};
}

export function codex(model: string): AgentProvider {
	const providerEnv = {};
	return {
		name: "codex",
		env: providerEnv,
		qualityGateCommand: "$quality-gate",
		buildPrintCommand(options: BuildPrintCommandOptions = {}): PrintCommand {
			return {
				cmd: "codex",
				args: [
					"exec",
					"--json",
					"--dangerously-bypass-approvals-and-sandbox",
					"-m",
					model,
					...(options.prompt !== undefined ? [options.prompt] : []),
				],
				env: providerEnv,
			};
		},
		parseStreamLine(line: string): readonly ParsedStreamEvent[] {
			const event = parseJsonLine(line);
			return event === undefined ? [] : parseCodexEvent(event, model);
		},
		parseSessionUsage: parseCodexUsage,
	};
}

export function createAgentProvider(
	name: AgentName,
	model: string,
): AgentProvider {
	switch (name) {
		case "claude":
			return claude(model);
		case "codex":
			return codex(model);
	}
}

function parseJsonLine(line: string): unknown | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function parseClaudeEvent(event: unknown): ParsedStreamEvent[] {
	if (!isRecord(event)) return [];

	if (event.type === "system" && event.subtype === "init") {
		const events: ParsedStreamEvent[] = [];
		if (typeof event.session_id === "string") {
			events.push({ kind: "session_id", sessionId: event.session_id });
		}
		if (typeof event.model === "string") {
			events.push({ kind: "session_id", model: event.model });
		}
		return events;
	}

	if (event.type === "assistant") {
		const message = event.message;
		if (!isRecord(message) || !Array.isArray(message.content)) return [];

		const events: ParsedStreamEvent[] = [];
		for (const block of message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") {
				events.push({ kind: "text", text: block.text });
			} else if (block.type === "tool_use") {
				events.push({
					kind: "tool_call",
					name: typeof block.name === "string" ? block.name : "tool",
					input: block.input,
				});
			}
		}
		return events;
	}

	if (event.type === "result") {
		const usage = parseClaudeUsage(event.usage);
		const model = typeof event.model === "string" ? event.model : undefined;
		if (usage === undefined) return [];
		return [
			{
				kind: "result",
				usage,
				...(model !== undefined ? { model } : {}),
			},
		];
	}

	return [];
}

/**
 * Parse one line of Codex `exec --json` output (Codex CLI >= 0.133),
 * which emits a thread/turn/item event stream. The stream carries no
 * model id, so `model` (the requested model) is stamped onto the
 * terminal `result` event for downstream pricing/display.
 */
function parseCodexEvent(event: unknown, model: string): ParsedStreamEvent[] {
	if (!isRecord(event)) return [];

	if (event.type === "thread.started" && typeof event.thread_id === "string") {
		return [{ kind: "session_id", sessionId: event.thread_id }];
	}
	if (event.type === "item.completed" && isRecord(event.item)) {
		return parseCodexItem(event.item);
	}
	if (event.type === "turn.completed") {
		const usage = parseCodexUsage(event.usage);
		return usage === undefined ? [] : [{ kind: "result", usage, model }];
	}

	// `turn.started`, `item.started`, and `item.updated` carry no payload
	// we surface — items are rendered once, on `item.completed`.
	return [];
}

/** Map a completed Codex thread item to surfaced stream events. */
function parseCodexItem(item: Record<string, unknown>): ParsedStreamEvent[] {
	switch (item.type) {
		case "agent_message":
			return typeof item.text === "string"
				? [{ kind: "text", text: item.text }]
				: [];
		case "command_execution":
			return typeof item.command === "string"
				? [{ kind: "tool_call", name: "shell", input: item.command }]
				: [];
		case "file_change":
			return [{ kind: "tool_call", name: "apply_patch", input: item.changes }];
		default:
			return [];
	}
}

function parseClaudeUsage(raw: unknown): IterationUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const inputTokens = tokenCountOr(raw.input_tokens, 0);
	const outputTokens = tokenCountOr(raw.output_tokens, 0);
	const cacheCreateTokens = tokenCountOr(raw.cache_creation_input_tokens, 0);
	const cacheReadTokens = tokenCountOr(raw.cache_read_input_tokens, 0);
	return nonZeroUsage({
		inputTokens,
		outputTokens,
		cacheCreateTokens,
		cacheReadTokens,
	});
}

/**
 * Parse Codex `turn.completed` usage. `input_tokens` is the total
 * prompt size and `cached_input_tokens` a subset of it; we split out
 * the cache-read portion the way the cost model expects.
 * `reasoning_output_tokens` is already included in `output_tokens`,
 * so it is not added again.
 */
function parseCodexUsage(raw: unknown): IterationUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const totalInputTokens = tokenCountOr(raw.input_tokens, 0);
	const cacheReadTokens = Math.min(
		totalInputTokens,
		tokenCountOr(raw.cached_input_tokens, 0),
	);
	const inputTokens = totalInputTokens - cacheReadTokens;
	const outputTokens = tokenCountOr(raw.output_tokens, 0);
	return nonZeroUsage({
		inputTokens,
		outputTokens,
		cacheCreateTokens: 0,
		cacheReadTokens,
	});
}

function nonZeroUsage(usage: IterationUsage): IterationUsage | undefined {
	if (
		usage.inputTokens === 0 &&
		usage.outputTokens === 0 &&
		usage.cacheCreateTokens === 0 &&
		usage.cacheReadTokens === 0
	) {
		return undefined;
	}
	return usage;
}

function tokenCountOr(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
