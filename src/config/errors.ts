import type { ZodError, ZodIssue } from "zod";

/** Thrown when a config or secrets file fails validation. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * Render a `ZodError` into a multi-line human-readable message keyed by
 * the source filename. Each issue line carries the full JSON path of the
 * failing field plus a remediation suggestion appropriate to the issue
 * kind (enum valid-value list, secret-key relocation hint, etc.).
 */
export function formatZodError(err: ZodError, source: string): string {
	const lines = [`Invalid config in ${source}:`];
	for (const issue of err.issues) {
		lines.push(`  - ${formatIssue(issue)}`);
	}
	return lines.join("\n");
}

function formatIssue(issue: ZodIssue): string {
	const path = renderPath(issue.path);
	const suggestion = suggest(issue);
	const where = path.length > 0 ? `${path}: ` : "";
	return suggestion.length > 0
		? `${where}${issue.message}\n    suggestion: ${suggestion}`
		: `${where}${issue.message}`;
}

function renderPath(path: ReadonlyArray<string | number>): string {
	let out = "";
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`;
		} else if (out.length === 0) {
			out = segment;
		} else {
			out += `.${segment}`;
		}
	}
	return out;
}

function suggest(issue: ZodIssue): string {
	if (issue.code === "invalid_enum_value") {
		return `valid values: ${issue.options.map((v) => JSON.stringify(v)).join(", ")}`;
	}
	if (issue.code === "unrecognized_keys") {
		return `remove unknown key(s): ${issue.keys.join(", ")}`;
	}
	if (issue.code === "custom") {
		const params = issue.params as { kind?: string } | undefined;
		if (params?.kind === "forbidden-secret") {
			return "secrets belong in .ralph/.env, not in the committed config file";
		}
	}
	if (issue.code === "invalid_type") {
		return `expected ${issue.expected}, got ${issue.received}`;
	}
	if (issue.code === "too_small") {
		return `must be ${issue.inclusive ? ">=" : ">"} ${String(issue.minimum)}`;
	}
	if (issue.code === "too_big") {
		return `must be ${issue.inclusive ? "<=" : "<"} ${String(issue.maximum)}`;
	}
	if (issue.code === "invalid_string") {
		return "check the value format";
	}
	return "";
}
