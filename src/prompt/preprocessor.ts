import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

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

export type RunShell = (cmd: string) => Promise<ShellResult>;

export type RenderOptions = {
	readonly runShell?: RunShell;
	readonly maxOutputBytes?: number;
};

/**
 * Hard cap on bytes kept from any single shell-expression output before
 * truncation kicks in. Resolves PRD open question #7 ("how big can
 * `bd memories` get before we choke the prompt?").
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 4096;

const PLACEHOLDER = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

/**
 * A shell-expression line: optional leading whitespace, then `!` followed by
 * a backtick-delimited command, then optional trailing whitespace, until the
 * end of the line. Matches one expression per line — multi-line commands
 * are out of scope.
 */
const SHELL_LINE = /^([ \t]*)!`([^`\n]+)`[ \t]*$/gm;

export async function renderPrompt(
	template: string,
	ctx: PromptContext,
	opts?: RenderOptions,
): Promise<string> {
	const substituted = substitutePlaceholders(template, ctx);
	return await expandShellExpressions(
		substituted,
		opts?.runShell ?? defaultShellRunner,
		opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
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

/**
 * Production shell runner used by `renderPrompt` when callers don't supply
 * their own. Spawns the command through `/bin/sh -c` so users can write
 * shell-style expressions (pipes, redirects, env vars) without our parser
 * having to understand them.
 */
export const defaultShellRunner: RunShell = (cmd) =>
	new Promise<ShellResult>((resolve) => {
		const child = spawn("/bin/sh", ["-c", cmd], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (err) => {
			resolve({
				stdout,
				stderr: `${stderr}${stderr.length > 0 ? "\n" : ""}${err.message}`,
				exitCode: -1,
			});
		});

		child.on("close", (code, signal) => {
			const exitCode = code ?? (signal !== null ? 128 : 1);
			resolve({ stdout, stderr, exitCode });
		});
	});

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
): Promise<string> {
	// Collect matches first; replacement is async so we can't use String.replace.
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

	if (matches.length === 0) {
		return text;
	}

	// Run all expressions sequentially to keep ordering deterministic and
	// avoid hammering the host with parallel subprocesses.
	const out: string[] = [];
	let cursor = 0;
	for (const match of matches) {
		out.push(text.slice(cursor, match.start));
		const block = await runOne(runShell, match.cmd, maxOutputBytes);
		const indented = indentBlock(block, match.indent);
		out.push(indented);
		cursor = match.end;
	}
	out.push(text.slice(cursor));
	return out.join("");
}

async function runOne(
	runShell: RunShell,
	cmd: string,
	maxOutputBytes: number,
): Promise<string> {
	let result: ShellResult;
	try {
		result = await runShell(cmd);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return formatShellError(cmd, { reason: message });
	}

	if (result.exitCode !== 0) {
		return formatShellError(cmd, {
			exitCode: result.exitCode,
			stderr: result.stderr,
			stdout: result.stdout,
		});
	}

	const stdout = trimTrailingNewlines(result.stdout);
	return truncate(stdout, maxOutputBytes);
}

function truncate(s: string, maxBytes: number): string {
	if (maxBytes <= 0 || s.length <= maxBytes) return s;
	const kept = s.slice(0, maxBytes);
	const dropped = s.length - maxBytes;
	return `${kept}...(${dropped} more bytes truncated)`;
}

function formatShellError(
	cmd: string,
	detail: {
		readonly exitCode?: number;
		readonly stderr?: string;
		readonly stdout?: string;
		readonly reason?: string;
	},
): string {
	const parts: string[] = [`cmd=\`${cmd}\``];
	if (detail.exitCode !== undefined) {
		parts.push(`exit=${detail.exitCode}`);
	}
	if (detail.reason !== undefined && detail.reason.length > 0) {
		parts.push(`reason=${oneLine(detail.reason)}`);
	}
	const stderr = (detail.stderr ?? "").trim();
	if (stderr.length > 0) {
		parts.push(`stderr=${oneLine(stderr)}`);
	}
	return `[shell-error: ${parts.join(" ")}]`;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function trimTrailingNewlines(s: string): string {
	return s.replace(/\n+$/, "");
}

function indentBlock(block: string, indent: string): string {
	if (indent === "") return block;
	return block
		.split("\n")
		.map((line) => `${indent}${line}`)
		.join("\n");
}
