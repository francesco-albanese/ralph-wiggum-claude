import type { AgentName } from "./schema.js";

/**
 * The fully-defaulted config Ralph runs with when neither
 * `.ralph/ralph.config.json` nor CLI flags supply a value. These
 * defaults are documented in the v1 PRD ("Defaults" section).
 *
 * `feedbackLoop` is intentionally absent here: undefined means
 * "autodiscover the project's checks at runtime"; an explicit
 * `string[]` override (even an empty one) bypasses autodiscovery.
 * Don't fall this back to `[]` — that would silently disable
 * autodiscovery for any user who never opens their config file.
 */
export const DEFAULT_CONFIG = {
	defaultAgent: "claude" as AgentName,
	defaultModel: "sonnet",
	maxIter: 10,
	branchPrefixes: [
		"feat",
		"fix",
		"chore",
		"docs",
		"refactor",
		"perf",
		"test",
		"style",
	],
	completionSignal: "<promise>COMPLETE</promise>",
} as const;

/** Resolved config after merging defaults + file + CLI flags. */
export type ResolvedConfig = {
	readonly defaultAgent: AgentName;
	readonly defaultModel: string;
	readonly maxIter: number;
	readonly branchPrefixes: ReadonlyArray<string>;
	readonly completionSignal: string;
	/** undefined → autodiscover; defined → explicit override (even if empty). */
	readonly feedbackLoop?: ReadonlyArray<string>;
};

export type CliOverrides = Partial<{
	defaultAgent: AgentName;
	defaultModel: string;
	maxIter: number;
	branchPrefixes: ReadonlyArray<string>;
	completionSignal: string;
	feedbackLoop: ReadonlyArray<string>;
}>;
