import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	cancel,
	confirm,
	intro,
	isCancel,
	multiselect,
	note,
	outro,
	select,
	text,
} from "@clack/prompts";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { AGENT_NAMES, type AgentName } from "../config/schema.js";
import {
	type InitAnswers,
	type InitPlan,
	planInit,
	RALPH_PATHS,
} from "./plan.js";

export type RunInitInput = {
	readonly cwd: string;
	readonly force: boolean;
	readonly openEditor: boolean;
};

/**
 * Interactive `ralph init` wizard. Prompts the user for config defaults,
 * scaffolds `.ralph/` artefacts, updates `.gitignore`, and opens the new
 * prompt in `$EDITOR` so the user can immediately tailor it.
 *
 * If any of the scaffolded files already exist and `force` is false,
 * the user is asked to confirm before any write happens. Confirming
 * overwrites all conflicting files atomically (well: sequentially —
 * we accept the small window where a partial overwrite is visible if
 * a write fails mid-way; the failure is surfaced and the user can
 * re-run).
 *
 * Returns nothing; failures throw and are caught by the CLI shell.
 * Cancellation (Ctrl-C inside a prompt) is a soft exit: prints a
 * cancellation note and exits 0, matching clack convention.
 */
export async function runInit(input: RunInitInput): Promise<void> {
	const { cwd, force, openEditor } = input;

	intro("ralph init");

	const answers = await collectAnswers();
	if (answers === undefined) return; // user cancelled

	const existingGitignore = await safeReadFile(
		join(cwd, RALPH_PATHS.gitignore),
	);
	const plan = planInit(answers, existingGitignore);

	const conflicts = await detectConflicts(cwd, plan);
	if (conflicts.length > 0 && !force) {
		const confirmed = await confirm({
			message: `Overwrite ${conflicts.length} existing file(s)? (${conflicts.join(", ")})`,
			initialValue: false,
		});
		if (isCancel(confirmed) || confirmed !== true) {
			cancel("ralph init: aborted (no files were written)");
			return;
		}
	}

	await applyPlan(cwd, plan);

	note(
		`Wrote ${plan.writes.length} file(s) and updated .gitignore.`,
		"scaffolded",
	);

	if (openEditor) {
		await openInEditor(join(cwd, RALPH_PATHS.prompt));
	}

	outro("ralph init: done. Edit .ralph/prompt.md to tailor the agent loop.");
}

async function collectAnswers(): Promise<InitAnswers | undefined> {
	const defaultAgent = await select<AgentName>({
		message: "Default agent provider",
		options: AGENT_NAMES.map((name) => ({ value: name, label: name })),
		initialValue: DEFAULT_CONFIG.defaultAgent,
	});
	if (isCancel(defaultAgent)) return cancelAndExit();

	const defaultModel = await text({
		message: "Default model",
		placeholder: DEFAULT_CONFIG.defaultModel,
		defaultValue: DEFAULT_CONFIG.defaultModel,
	});
	if (isCancel(defaultModel)) return cancelAndExit();

	const maxIterRaw = await text({
		message: "Max iterations per invocation",
		placeholder: String(DEFAULT_CONFIG.maxIter),
		defaultValue: String(DEFAULT_CONFIG.maxIter),
		validate: (value) => {
			// clack passes the raw input (or undefined when user submits an
			// empty value with no defaultValue). Coercing undefined -> ""
			// keeps the check simple: empty input is invalid here.
			const raw = value ?? "";
			const trimmed = raw.trim();
			const n = Number.parseInt(trimmed, 10);
			if (!Number.isFinite(n) || n <= 0 || String(n) !== trimmed) {
				return "Must be a positive integer";
			}
			return undefined;
		},
	});
	if (isCancel(maxIterRaw)) return cancelAndExit();

	const branchPrefixes = await multiselect<string>({
		message: "Allowed branch prefixes (space to toggle)",
		options: DEFAULT_CONFIG.branchPrefixes.map((p) => ({
			value: p,
			label: p,
		})),
		initialValues: [...DEFAULT_CONFIG.branchPrefixes],
		required: true,
	});
	if (isCancel(branchPrefixes)) return cancelAndExit();

	const completionSignal = await text({
		message: "Completion signal (the agent emits this to stop the loop)",
		placeholder: DEFAULT_CONFIG.completionSignal,
		defaultValue: DEFAULT_CONFIG.completionSignal,
		validate: (value) =>
			(value ?? "").trim().length === 0 ? "Cannot be empty" : undefined,
	});
	if (isCancel(completionSignal)) return cancelAndExit();

	return {
		defaultAgent,
		defaultModel: stringOr(defaultModel, DEFAULT_CONFIG.defaultModel),
		maxIter: Number.parseInt(
			stringOr(maxIterRaw, String(DEFAULT_CONFIG.maxIter)),
			10,
		),
		branchPrefixes,
		completionSignal: stringOr(
			completionSignal,
			DEFAULT_CONFIG.completionSignal,
		),
	};
}

function cancelAndExit(): undefined {
	cancel("ralph init: cancelled");
	return undefined;
}

/**
 * clack `text()` returns `string | symbol` after `isCancel` rules out
 * cancellation. The `defaultValue` path can still yield an empty string
 * if the user hits enter with nothing typed; we coerce that to the
 * documented default so the resulting config never serialises empty
 * strings for required fields.
 */
function stringOr(value: string | symbol, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length === 0 ? fallback : trimmed;
}

async function detectConflicts(
	cwd: string,
	plan: InitPlan,
): Promise<ReadonlyArray<string>> {
	const conflicts: string[] = [];
	for (const write of plan.writes) {
		if (await pathExists(join(cwd, write.path))) {
			conflicts.push(write.path);
		}
	}
	return conflicts;
}

async function applyPlan(cwd: string, plan: InitPlan): Promise<void> {
	for (const write of plan.writes) {
		await writeFileEnsuringDir(join(cwd, write.path), write.content);
	}
	await writeFile(
		join(cwd, RALPH_PATHS.gitignore),
		plan.gitignoreContent,
		"utf8",
	);
}

async function writeFileEnsuringDir(
	target: string,
	content: string,
): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
}

async function safeReadFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if (isNodeErrnoException(err) && err.code === "ENOENT") return undefined;
		throw err;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err) {
		if (isNodeErrnoException(err) && err.code === "ENOENT") return false;
		throw err;
	}
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return (
		err instanceof Error &&
		typeof (err as NodeJS.ErrnoException).code === "string"
	);
}

/**
 * Spawn `$EDITOR <path>` and wait for it to exit. Falls back to a no-op
 * (with a note) when no editor is configured — running `ralph init`
 * unattended (CI, tests with `--no-editor`) shouldn't error out.
 *
 * stdio is inherited so terminal editors (vim, nano, helix) get the
 * user's TTY without ceremony. GUI editors typically return immediately
 * after spawning their window; for those, `--wait` (VSCode) or `-w`
 * (Sublime) is the user's responsibility to bake into `$EDITOR`.
 */
async function openInEditor(path: string): Promise<void> {
	const editor = process.env.EDITOR ?? process.env.VISUAL;
	if (editor === undefined || editor.trim().length === 0) {
		note(
			`No $EDITOR set — open ${path} manually to tailor the prompt.`,
			"editor",
		);
		return;
	}

	// `/bin/sh -c` so users can put flags in $EDITOR (`code --wait`,
	// `nvim -p`, etc.) without us re-parsing shell syntax.
	const cmd = `${editor} ${shellEscape(path)}`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", cmd], { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0 || code === null) {
				resolve();
				return;
			}
			reject(new Error(`editor exited with code ${code}`));
		});
	});
}

function shellEscape(s: string): string {
	// POSIX single-quote escape: wrap in single quotes, escape any embedded
	// single quote as '\''. Safe for arbitrary paths including spaces.
	return `'${s.replace(/'/g, "'\\''")}'`;
}
