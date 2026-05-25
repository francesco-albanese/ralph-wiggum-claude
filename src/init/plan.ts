import type { AgentName } from "../config/schema.js";
import { BUNDLED_ENV_EXAMPLE, BUNDLED_PROMPT_TEMPLATE } from "./template.js";

/**
 * The user's answers from the interactive wizard. The fields mirror the
 * subset of `RalphConfigFile` we surface in the prompts — anything not
 * listed here falls back to `DEFAULT_CONFIG` at load time, so users
 * aren't forced to make decisions they don't care about.
 */
export type InitAnswers = {
	readonly defaultAgent: AgentName;
	readonly defaultModel: string;
	readonly maxIter: number;
	readonly branchPrefixes: ReadonlyArray<string>;
	readonly completionSignal: string;
};

export type FileWrite = {
	readonly path: string;
	readonly content: string;
};

export type InitPlan = {
	readonly writes: ReadonlyArray<FileWrite>;
	/**
	 * The post-mutation `.gitignore` content. Caller writes it back as-is.
	 * Computed (vs. expressed as a diff) so tests can assert the full file
	 * shape and the IO layer doesn't have to re-apply logic.
	 */
	readonly gitignoreContent: string;
};

/**
 * Paths Ralph scaffolds, relative to the project root.
 */
export const RALPH_PATHS = {
	configFile: ".ralph/ralph.config.json",
	envExample: ".ralph/.env.example",
	prompt: ".ralph/prompt.md",
	gitignore: ".gitignore",
} as const;

/**
 * The gitignore entries `ralph init` ensures exist. `.ralph/.env` is
 * NOT a glob — `.ralph/.env*` would also ignore the committed
 * `.env.example`, which defeats the point of shipping the template.
 */
export const RALPH_GITIGNORE_ENTRIES: ReadonlyArray<string> = [
	".ralph/.env",
	".ralph/state/",
	".ralph/logs/",
	".ralph/worktrees/",
];

const GITIGNORE_SECTION_HEADER = "# Ralph runtime";

/**
 * Build the on-disk plan for a fresh `ralph init`. Pure: no IO, no clack,
 * no env access. The IO shell in `src/init/index.ts` is responsible for
 * actually writing files and prompting the user.
 *
 * `existingGitignore` is the current `.gitignore` text (or `undefined`
 * if no `.gitignore` exists). The function returns the post-mutation
 * text — idempotent: re-running the wizard does not duplicate entries.
 */
export function planInit(
	answers: InitAnswers,
	existingGitignore: string | undefined,
): InitPlan {
	const configContent = renderConfigFile(answers);
	const gitignoreContent = upsertGitignoreEntries(
		existingGitignore,
		RALPH_GITIGNORE_ENTRIES,
	);

	return {
		writes: [
			{ path: RALPH_PATHS.configFile, content: configContent },
			{ path: RALPH_PATHS.envExample, content: BUNDLED_ENV_EXAMPLE },
			{ path: RALPH_PATHS.prompt, content: BUNDLED_PROMPT_TEMPLATE },
		],
		gitignoreContent,
	};
}

function renderConfigFile(answers: InitAnswers): string {
	// Stable key order so re-running the wizard produces a stable diff.
	const ordered = {
		defaultAgent: answers.defaultAgent,
		defaultModel: answers.defaultModel,
		maxIter: answers.maxIter,
		branchPrefixes: [...answers.branchPrefixes],
		completionSignal: answers.completionSignal,
	};
	// Trailing newline for POSIX-friendly editors and clean `git diff` output.
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Add the Ralph-runtime entries to `.gitignore` without duplicating
 * lines that already exist. Two collision-handling rules:
 *
 *  1. Exact-line matches (after trim) are not re-added — keeps re-runs
 *     idempotent.
 *  2. A pre-existing `.ralph/.env*` (or similar wildcard) is *removed*
 *     when we add `.ralph/.env`. The example template needs to be
 *     committable; a wildcard would silently exclude `.env.example`.
 *     Old shape from earlier scaffolds — clean it up on re-init.
 *
 * New entries land in a dedicated `# Ralph runtime` section appended at
 * the end of the file, with a single trailing newline. If the section
 * already exists (re-run), we splice missing entries into it instead of
 * starting a second section.
 */
export function upsertGitignoreEntries(
	existing: string | undefined,
	entries: ReadonlyArray<string>,
): string {
	const lines = existing === undefined ? [] : existing.split("\n");
	// `.split("\n")` on a trailing-newline file produces an empty final
	// element; we keep it so we can re-join cleanly at the end.
	const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	if (hasTrailingNewline) lines.pop();

	const filtered = lines.filter((line) => !isOverbroadRalphEnvIgnore(line));

	const existingSet = new Set(
		filtered.map((line) => line.trim()).filter((line) => line.length > 0),
	);

	const missing = entries.filter((entry) => !existingSet.has(entry));

	if (missing.length === 0) {
		// All entries already present. `filtered` may still differ from the
		// original if we scrubbed an overbroad `.ralph/.env*` wildcard, so
		// we re-emit the (possibly mutated) line list rather than return
		// `existing` unchanged.
		return `${filtered.join("\n")}\n`;
	}

	const headerIdx = filtered.findIndex(
		(line) => line.trim() === GITIGNORE_SECTION_HEADER,
	);

	if (headerIdx === -1) {
		// Fresh section. Pad with a blank line before the header if the
		// file is non-empty and doesn't already end on a blank line.
		const needsLeadingBlank =
			filtered.length > 0 && filtered[filtered.length - 1] !== "";
		const appended = [
			...filtered,
			...(needsLeadingBlank ? [""] : []),
			GITIGNORE_SECTION_HEADER,
			...missing,
		];
		return `${appended.join("\n")}\n`;
	}

	// Section exists; splice missing entries directly after the header.
	// Keep ordering deterministic so re-runs produce stable output.
	const before = filtered.slice(0, headerIdx + 1);
	const after = filtered.slice(headerIdx + 1);
	const spliced = [...before, ...missing, ...after];
	return `${spliced.join("\n")}\n`;
}

/**
 * Detect the old `.ralph/.env*` wildcard (and `.ralph/.env.*` variant)
 * that an earlier scaffolder shipped. We rewrite it to the non-wildcard
 * form to avoid silently ignoring the `.env.example` template.
 */
function isOverbroadRalphEnvIgnore(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === ".ralph/.env*" || trimmed === ".ralph/.env.*";
}
