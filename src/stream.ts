import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

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
 */
export async function streamAgentText(
	stdout: Readable,
	out: NodeJS.WritableStream,
): Promise<void> {
	const rl = createInterface({ input: stdout, crlfDelay: Infinity });

	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}

		const text = extractAssistantText(event);
		if (text.length > 0) {
			out.write(text);
		}
	}
}

function extractAssistantText(event: unknown): string {
	if (!isRecord(event)) return "";
	if (event["type"] !== "assistant") return "";

	const message = event["message"];
	if (!isRecord(message)) return "";

	const content = message["content"];
	if (!Array.isArray(content)) return "";

	let out = "";
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block["type"] !== "text") continue;
		const text = block["text"];
		if (typeof text === "string") out += text;
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
