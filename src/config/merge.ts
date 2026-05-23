import { DEFAULT_CONFIG, type ResolvedConfig } from "./defaults.js";
import type { RalphConfigFile } from "./schema.js";

/**
 * Merge defaults + config-file + CLI under the precedence rule
 * CLI > file > defaults. `feedbackLoop` is special: it uses `??` (not
 * `||`) so an explicit empty array bypasses autodiscovery instead of
 * falling through to the default-undefined branch.
 */
export function mergeConfig(
	fromFile: Partial<RalphConfigFile>,
	fromCli: Partial<RalphConfigFile>,
): ResolvedConfig {
	const defaults = DEFAULT_CONFIG;

	const pick = <K extends keyof RalphConfigFile>(
		key: K,
		fallback: NonNullable<RalphConfigFile[K]>,
	): NonNullable<RalphConfigFile[K]> => {
		const cli = fromCli[key];
		if (cli !== undefined) return cli as NonNullable<RalphConfigFile[K]>;
		const file = fromFile[key];
		if (file !== undefined) return file as NonNullable<RalphConfigFile[K]>;
		return fallback;
	};

	const feedbackLoop = fromCli.feedbackLoop ?? fromFile.feedbackLoop;

	return {
		defaultAgent: pick("defaultAgent", defaults.defaultAgent),
		defaultModel: pick("defaultModel", defaults.defaultModel),
		maxIter: pick("maxIter", defaults.maxIter),
		branchPrefixes: pick("branchPrefixes", [...defaults.branchPrefixes]),
		completionSignal: pick("completionSignal", defaults.completionSignal),
		...(feedbackLoop !== undefined ? { feedbackLoop } : {}),
	};
}
