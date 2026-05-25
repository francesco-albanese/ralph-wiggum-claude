import type { CostBreakdown } from "../cost.js";
import type { ParsedStreamEvent } from "../stream.js";

export function defaultDim(text: string): string {
	// ANSI 2 = dim. Avoid pulling in a colour lib for one escape.
	return `\x1b[2m${text}\x1b[22m`;
}

export function formatToolLine(
	name: string,
	input: unknown,
	maxArgChars: number,
): string {
	const args = formatToolArgs(input, maxArgChars);
	return args.length > 0 ? `${name}: ${args}` : name;
}

function formatToolArgs(input: unknown, maxChars: number): string {
	if (input === undefined || input === null) return "";
	if (typeof input === "string") return truncate(input, maxChars);
	if (typeof input !== "object") return truncate(String(input), maxChars);

	const rec = input as Record<string, unknown>;
	for (const key of [
		"command",
		"cmd",
		"file_path",
		"filePath",
		"path",
		"pattern",
		"query",
		"url",
	]) {
		const v = rec[key];
		if (typeof v === "string") return truncate(v, maxChars);
	}
	const json = JSON.stringify(input);
	return truncate(json, maxChars);
}

function truncate(s: string, max: number): string {
	const collapsed = s.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

export function zeroCost(): CostBreakdown {
	return {
		inputUsd: 0,
		outputUsd: 0,
		cacheCreateUsd: 0,
		cacheReadUsd: 0,
		totalUsd: 0,
	};
}

export function redactStreamEvent(event: ParsedStreamEvent): ParsedStreamEvent {
	switch (event.kind) {
		case "text":
			return { kind: "text", text: redactedText(event.text) };
		case "tool_call":
			return { kind: "tool_call", name: event.name, input: "[redacted]" };
		default:
			return event;
	}
}

function redactedText(text: string): string {
	return `[redacted ${text.length} chars]`;
}
