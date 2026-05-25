import {
	readAndValidateConfigFile,
	validateCliOverrides,
} from "./config-file.js";
import type { CliOverrides, ResolvedConfig } from "./defaults.js";
import { readAndValidateEnvFile } from "./env-file.js";
import { mergeConfig } from "./merge.js";
import type { RalphSecrets } from "./schema.js";

// Re-exports — keep the public surface stable so callers can still
// `import { loadConfig, DEFAULT_CONFIG, ... } from "./config/loader.js"`
// without knowing which sub-module each symbol lives in.
export { CONFIG_FILE_NAME } from "./config-file.js";
export type { CliOverrides, ResolvedConfig } from "./defaults.js";
export { DEFAULT_CONFIG } from "./defaults.js";
export { ENV_FILE_NAME } from "./env-file.js";
export { ConfigError } from "./errors.js";

export type LoadConfigInput = {
	readonly cwd: string;
	readonly cliOverrides: CliOverrides;
	readonly env: Readonly<Record<string, string | undefined>>;
};

export type LoadConfigResult = {
	readonly config: ResolvedConfig;
	readonly secrets: RalphSecrets;
	readonly sources: {
		readonly configFile: "loaded" | "missing";
		readonly envFile: "loaded" | "missing";
	};
};

/**
 * Load and validate Ralph's project config + secrets, then merge with
 * CLI overrides under the precedence rule: CLI > file > defaults.
 *
 * Throws a `ConfigError` on schema violations or on a committed-secret
 * leak in the config file. Missing files are not errors — they fall
 * through to defaults.
 */
export async function loadConfig(
	input: LoadConfigInput,
): Promise<LoadConfigResult> {
	const { cwd, cliOverrides, env } = input;

	const fileResult = await readAndValidateConfigFile(cwd);
	const envResult = await readAndValidateEnvFile(cwd, env);
	const cliConfig = validateCliOverrides(cliOverrides);

	const merged = mergeConfig(fileResult.value, cliConfig);

	return {
		config: merged,
		secrets: envResult.value,
		sources: {
			configFile: fileResult.source,
			envFile: envResult.source,
		},
	};
}
