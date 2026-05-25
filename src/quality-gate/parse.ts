import {
	QG_OUTPUT_CLOSE,
	QG_OUTPUT_OPEN,
	type QgAgentOutput,
	type QgFinding,
} from "./types.js";

export function parseQgAgentOutput(streamedText: string): QgAgentOutput {
	const openAt = streamedText.lastIndexOf(QG_OUTPUT_OPEN);
	if (openAt === -1) {
		throw new Error(
			`quality gate output missing required ${QG_OUTPUT_OPEN} block`,
		);
	}
	const closeAt = streamedText.indexOf(
		QG_OUTPUT_CLOSE,
		openAt + QG_OUTPUT_OPEN.length,
	);
	if (closeAt === -1) {
		throw new Error(
			`quality gate output missing closing ${QG_OUTPUT_CLOSE} marker`,
		);
	}
	const raw = streamedText
		.slice(openAt + QG_OUTPUT_OPEN.length, closeAt)
		.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`quality gate emitted invalid JSON: ${msg}`);
	}
	return coerceQgAgentOutput(parsed);
}

function coerceQgAgentOutput(value: unknown): QgAgentOutput {
	if (!isRecord(value)) {
		throw new Error("quality gate output must be a JSON object");
	}
	const prRaw = value.pr;
	if (!isRecord(prRaw)) {
		throw new Error("quality gate output missing `pr` object");
	}
	const subject = readString(prRaw.subject, "pr.subject");
	const summary = readString(prRaw.summary, "pr.summary");
	const closedBeads = readStringArray(prRaw.closedBeads, "pr.closedBeads");

	const followUpsRaw = value.followUps;
	if (!Array.isArray(followUpsRaw)) {
		throw new Error("quality gate output missing `followUps` array");
	}
	const followUps: QgFinding[] = followUpsRaw.map((entry, i) => {
		if (!isRecord(entry)) {
			throw new Error(`followUps[${i}] must be an object`);
		}
		const severity = entry.severity;
		if (severity !== "high" && severity !== "medium" && severity !== "low") {
			throw new Error(
				`followUps[${i}].severity must be one of high/medium/low (got ${String(severity)})`,
			);
		}
		const title = readString(entry.title, `followUps[${i}].title`);
		const detail =
			entry.detail === undefined
				? undefined
				: readString(entry.detail, `followUps[${i}].detail`);
		return detail === undefined
			? { severity, title }
			: { severity, title, detail };
	});

	return {
		pr: { subject, summary, closedBeads },
		followUps,
	};
}

export function readString(value: unknown, path: string): string {
	if (typeof value !== "string") {
		throw new Error(`${path} must be a string`);
	}
	return value;
}

function readStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`${path} must be an array of strings`);
	}
	return value.map((v, i) => readString(v, `${path}[${i}]`));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
