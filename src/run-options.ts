import {
	readAndValidateConfigFile,
	validateCliOverrides,
} from "./config/config-file.js";
import type { CliOverrides } from "./config/defaults.js";
import { mergeConfig } from "./config/merge.js";
import { AGENT_NAMES, type AgentName } from "./config/schema.js";
import type { RunOptions } from "./run.js";

/**
 * Timeout has no config-file source (it is not in the config schema), so
 * unlike agent/model/maxIter it cannot be supplied by `ralph.config.json`.
 * Its default is therefore applied here rather than via `mergeConfig`.
 */
const DEFAULT_TIMEOUT_MIN = 30;

/** Raw commander option strings for `ralph run`, before validation. */
export type RawCliOptions = {
	readonly branch: string;
	readonly agent?: string;
	readonly model?: string;
	readonly maxIter?: string;
	readonly timeoutMin?: string;
	readonly completeSignal?: string;
	readonly detach?: boolean;
};

/**
 * Parsed CLI flags. Config-backed fields are `undefined` when the user did
 * not pass the flag — this is what lets the config merge distinguish
 * "not specified" from "specified as the default value". (Commander must
 * therefore declare these options WITHOUT a default string, or `raw.*`
 * would always be populated and shadow the config file.)
 */
export type ParsedRunFlags = {
	readonly branch: string;
	readonly agent?: AgentName;
	readonly model?: string;
	readonly maxIter?: number;
	readonly timeoutMin?: number;
	/** Raw `--complete-signal` regex source; compiled later, after merge. */
	readonly completeSignal?: string;
	readonly detach: boolean;
};

export function parseRunFlags(raw: RawCliOptions): ParsedRunFlags {
	const base: {
		branch: string;
		detach: boolean;
		agent?: AgentName;
		model?: string;
		maxIter?: number;
		timeoutMin?: number;
		completeSignal?: string;
	} = {
		branch: raw.branch,
		detach: raw.detach === true,
	};

	const agent = parseAgent(raw.agent);
	if (agent !== undefined) base.agent = agent;
	if (raw.model !== undefined) base.model = raw.model;
	if (raw.maxIter !== undefined) {
		base.maxIter = parsePositiveInt(raw.maxIter, "--max-iter");
	}
	if (raw.timeoutMin !== undefined) {
		base.timeoutMin = parsePositiveInt(raw.timeoutMin, "--timeout-min");
	}
	if (raw.completeSignal !== undefined)
		base.completeSignal = raw.completeSignal;

	return base;
}

export type ResolvedRunOptions = RunOptions & { readonly detach: boolean };

/**
 * Resolve the effective run options under the precedence rule
 * CLI > config-file > defaults, then compile the resolved completion
 * signal string into the `RegExp` the runtime expects.
 *
 * Uses `readAndValidateConfigFile` + `mergeConfig` directly (rather than
 * the full `loadConfig`) so the run path validates only the config file —
 * secrets (`.ralph/.env`) are validated separately at notify time.
 *
 * Throws a `ConfigError` on a malformed/forbidden config file, and a
 * plain `Error` when the resolved completion signal is not a valid regex.
 */
export async function resolveRunOptions(input: {
	readonly raw: RawCliOptions;
	readonly cwd: string;
}): Promise<ResolvedRunOptions> {
	const flags = parseRunFlags(input.raw);

	const overrides: CliOverrides = {};
	if (flags.agent !== undefined) overrides.defaultAgent = flags.agent;
	if (flags.model !== undefined) overrides.defaultModel = flags.model;
	if (flags.maxIter !== undefined) overrides.maxIter = flags.maxIter;
	if (flags.completeSignal !== undefined) {
		overrides.completionSignal = flags.completeSignal;
	}

	const fileResult = await readAndValidateConfigFile(input.cwd);
	const config = mergeConfig(fileResult.value, validateCliOverrides(overrides));

	return {
		branch: flags.branch,
		agent: config.defaultAgent,
		model: config.defaultModel,
		maxIter: config.maxIter,
		timeoutMin: flags.timeoutMin ?? DEFAULT_TIMEOUT_MIN,
		completeSignal: compileCompletionSignal(config.completionSignal),
		detach: flags.detach,
	};
}

function compileCompletionSignal(source: string): RegExp {
	try {
		return new RegExp(source);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid completion signal regex: ${msg}`);
	}
}

function parseAgent(value: string | undefined): AgentName | undefined {
	if (value === undefined) return undefined;
	if ((AGENT_NAMES as readonly string[]).includes(value)) {
		return value as AgentName;
	}
	throw new Error(`--agent must be one of: ${AGENT_NAMES.join(", ")}`);
}

function parsePositiveInt(value: string, flag: string): number {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== value.trim()) {
		throw new Error(`${flag} must be a positive integer (got ${value})`);
	}
	return n;
}
