import { readFile } from "node:fs/promises";
import {
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_TIMEOUT_MS,
	defaultShellRunner,
} from "./shell-runner.js";

export type PromptContext = {
	readonly branch: string;
	readonly targetBranch: string;
	readonly userVars?: Readonly<Record<string, string>>;
};

export type ShellResult = {
	readonly stdout: string;
	readonly exitCode: number;
	readonly stderr?: string;
};

export type RunShellOptions = {
	readonly maxOutputBytes?: number;
	readonly timeoutMs?: number;
};

export type RunShell = (
	cmd: string,
	opts?: RunShellOptions,
) => Promise<ShellResult>;

export type RenderOptions = {
	readonly runShell?: RunShell;
	readonly maxOutputBytes?: number;
	readonly timeoutMs?: number;
};

const PLACEHOLDER = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

/**
 * A shell-expression line: optional leading whitespace, then `!` followed by
 * a backtick-delimited command, then optional trailing whitespace, until the
 * end of the line. Matches one expression per line — multi-line commands
 * are out of scope.
 */
const SHELL_LINE = /^([ \t]*)!`([^`\n]+)`[ \t]*$/gm;

/**
 * Characters that would let a userVars value smuggle a shell-expression
 * line into the rendered prompt (backtick = SHELL_LINE delimiter, newline =
 * line break that SHELL_LINE could match on its own). Reject these at the
 * substitution boundary so a hostile or careless userVars entry can't
 * become arbitrary shell.
 */
const UNSAFE_USER_VAR = /[`\n\r]/;

export async function renderPrompt(
	template: string,
	ctx: PromptContext,
	opts?: RenderOptions,
): Promise<string> {
	validateUserVars(ctx.userVars);
	const substituted = substitutePlaceholders(template, ctx);
	const maxOutputBytes = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return await expandShellExpressions(
		substituted,
		opts?.runShell ?? defaultShellRunner,
		maxOutputBytes,
		timeoutMs,
	);
}

/**
 * Read `.ralph/prompt.md` (or any path) from disk and render it. Thin I/O
 * wrapper over `renderPrompt` so the pure transform stays unit-testable
 * with string inputs.
 */
export async function loadAndRenderPrompt(
	path: string,
	ctx: PromptContext,
	opts?: RenderOptions,
): Promise<string> {
	let template: string;
	try {
		template = await readFile(path, "utf8");
	} catch (err) {
		if (isNodeErrnoException(err) && err.code === "ENOENT") {
			throw new Error(
				`prompt file not found: ${path}. Run \`ralph init\` to scaffold one.`,
			);
		}
		throw err;
	}
	return await renderPrompt(template, ctx, opts);
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return (
		err instanceof Error &&
		typeof (err as NodeJS.ErrnoException).code === "string"
	);
}

export { defaultShellRunner } from "./shell-runner.js";

function validateUserVars(
	userVars: Readonly<Record<string, string>> | undefined,
): void {
	if (userVars === undefined) return;
	const offenders: string[] = [];
	for (const [key, value] of Object.entries(userVars)) {
		if (UNSAFE_USER_VAR.test(value)) offenders.push(key);
	}
	if (offenders.length > 0) {
		throw new Error(
			`userVars values must not contain backticks or newlines (shell-injection risk): ${offenders.join(", ")}`,
		);
	}
}

function substitutePlaceholders(template: string, ctx: PromptContext): string {
	const values: Record<string, string> = {
		...(ctx.userVars ?? {}),
		BRANCH: ctx.branch,
		TARGET_BRANCH: ctx.targetBranch,
	};

	const unmatched = new Set<string>();
	const substituted = template.replace(PLACEHOLDER, (_match, key: string) => {
		const value = values[key];
		if (value === undefined) {
			unmatched.add(key);
			return "";
		}
		return value;
	});

	if (unmatched.size > 0) {
		const keys = Array.from(unmatched).join(", ");
		throw new Error(
			`unmatched placeholder(s) in prompt: ${keys}. Provide a value via userVars or remove the placeholder.`,
		);
	}

	return substituted;
}

async function expandShellExpressions(
	text: string,
	runShell: RunShell,
	maxOutputBytes: number,
	timeoutMs: number,
): Promise<string> {
	const matches: Array<{
		readonly start: number;
		readonly end: number;
		readonly indent: string;
		readonly cmd: string;
	}> = [];

	SHELL_LINE.lastIndex = 0;
	let m: RegExpExecArray | null = SHELL_LINE.exec(text);
	while (m !== null) {
		matches.push({
			start: m.index,
			end: m.index + m[0].length,
			indent: m[1] ?? "",
			cmd: (m[2] ?? "").trim(),
		});
		m = SHELL_LINE.exec(text);
	}

	if (matches.length === 0) return text;

	// Run all expressions sequentially to keep ordering deterministic and
	// avoid hammering the host with parallel subprocesses.
	const out: string[] = [];
	let cursor = 0;
	for (const match of matches) {
		out.push(text.slice(cursor, match.start));
		const block = await runOne(runShell, match.cmd, maxOutputBytes, timeoutMs);
		out.push(indentBlock(block, match.indent));
		cursor = match.end;
	}
	out.push(text.slice(cursor));
	return out.join("");
}

async function runOne(
	runShell: RunShell,
	cmd: string,
	maxOutputBytes: number,
	timeoutMs: number,
): Promise<string> {
	let result: ShellResult;
	try {
		result = await runShell(cmd, { maxOutputBytes, timeoutMs });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return formatShellError(cmd, { reason: message });
	}

	if (result.exitCode !== 0) {
		return formatShellError(cmd, {
			exitCode: result.exitCode,
			stderr: truncate(result.stderr ?? "", maxOutputBytes),
		});
	}

	const stdout = trimTrailingNewlines(result.stdout);
	return truncate(stdout, maxOutputBytes);
}

function truncate(s: string, maxBytes: number): string {
	if (maxBytes <= 0) return s;
	const totalBytes = Buffer.byteLength(s, "utf8");
	if (totalBytes <= maxBytes) return s;
	// Buffer.toString gracefully handles partial multibyte sequences at the
	// boundary by emitting the Unicode replacement character — acceptable
	// for an already-truncated value.
	const kept = Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
	const dropped = totalBytes - maxBytes;
	return `${kept}...(${dropped} more bytes truncated)`;
}

function formatShellError(
	cmd: string,
	detail: {
		readonly exitCode?: number;
		readonly stderr?: string;
		readonly reason?: string;
	},
): string {
	const parts: string[] = [`cmd=\`${cmd}\``];
	if (detail.exitCode !== undefined) parts.push(`exit=${detail.exitCode}`);
	if (detail.reason !== undefined && detail.reason.length > 0) {
		parts.push(`reason=${oneLine(detail.reason)}`);
	}
	const stderr = (detail.stderr ?? "").trim();
	if (stderr.length > 0) parts.push(`stderr=${oneLine(stderr)}`);
	return `[shell-error: ${parts.join(" ")}]`;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function trimTrailingNewlines(s: string): string {
	return s.replace(/\n+$/, "");
}

function indentBlock(block: string, indent: string): string {
	if (indent === "" || block === "") return block;
	return block
		.split("\n")
		.map((line) => `${indent}${line}`)
		.join("\n");
}
