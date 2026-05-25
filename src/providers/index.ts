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
			return event === undefined ? [] : parseCodexEvent(event);
		},
		parseSessionUsage: parseOpenAiUsage,
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

function parseCodexEvent(event: unknown): ParsedStreamEvent[] {
	if (!isRecord(event)) return [];

	if (typeof event.session_id === "string") {
		return [{ kind: "session_id", sessionId: event.session_id }];
	}
	if (event.type === "thread.started" && typeof event.thread_id === "string") {
		return [{ kind: "session_id", sessionId: event.thread_id }];
	}
	if (event.type === "response.created" && isRecord(event.response)) {
		const response = event.response;
		const events: ParsedStreamEvent[] = [];
		if (typeof response.id === "string") {
			events.push({ kind: "session_id", sessionId: response.id });
		}
		if (typeof response.model === "string") {
			events.push({ kind: "session_id", model: response.model });
		}
		return events;
	}

	if (
		(event.type === "response.output_text.delta" ||
			event.type === "output_text.delta") &&
		typeof event.delta === "string"
	) {
		return [{ kind: "text", text: event.delta }];
	}
	if (
		(event.type === "agent_message" || event.type === "message") &&
		typeof event.message === "string"
	) {
		return [{ kind: "text", text: event.message }];
	}

	if (event.type === "response.output_item.done" && isRecord(event.item)) {
		const item = event.item;
		if (item.type === "function_call") {
			return [
				{
					kind: "tool_call",
					name: typeof item.name === "string" ? item.name : "tool",
					input: item.arguments,
				},
			];
		}
	}
	if (event.type === "tool_call") {
		return [
			{
				kind: "tool_call",
				name: typeof event.name === "string" ? event.name : "tool",
				input: event.arguments ?? event.input,
			},
		];
	}

	if (event.type === "response.completed" && isRecord(event.response)) {
		const response = event.response;
		const usage = parseOpenAiUsage(response.usage);
		const model =
			typeof response.model === "string" ? response.model : undefined;
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

function parseOpenAiUsage(raw: unknown): IterationUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const totalInputTokens = tokenCountOr(raw.input_tokens, 0);
	const inputDetails = isRecord(raw.input_tokens_details)
		? raw.input_tokens_details
		: undefined;
	const cacheReadTokens = Math.min(
		totalInputTokens,
		tokenCountOr(inputDetails?.cached_tokens, 0),
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
