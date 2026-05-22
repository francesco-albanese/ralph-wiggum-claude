import { join } from "node:path";
import type { CliOverrides } from "./defaults.js";
import { ConfigError, formatZodError } from "./errors.js";
import { safeReadFile } from "./io.js";
import {
	CliOverridesSchema,
	type RalphConfigFile,
	RalphConfigFileSchema,
} from "./schema.js";

export const CONFIG_FILE_NAME = ".ralph/ralph.config.json";

export type ConfigFileReadResult = {
	readonly value: Partial<RalphConfigFile>;
	readonly source: "loaded" | "missing";
};

/**
 * Read and validate `.ralph/ralph.config.json`. Missing file → empty
 * value + "missing" source (caller falls back to defaults). Malformed
 * JSON or schema violation → `ConfigError` with a path-aware message.
 */
export async function readAndValidateConfigFile(
	cwd: string,
): Promise<ConfigFileReadResult> {
	const path = join(cwd, CONFIG_FILE_NAME);
	const raw = await safeReadFile(path);
	if (raw === undefined) {
		return { value: {}, source: "missing" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new ConfigError(`Failed to parse ${CONFIG_FILE_NAME}: ${detail}`);
	}

	const result = RalphConfigFileSchema.safeParse(parsed);
	if (!result.success) {
		throw new ConfigError(formatZodError(result.error, CONFIG_FILE_NAME));
	}
	return { value: result.data, source: "loaded" };
}

/**
 * Validate runtime values supplied via CLI flags. Same shape as the
 * config file but WITHOUT the committed-secret guard — CLI flags come
 * from a typed surface and can never legally be secrets, so the
 * secret-scan would only ever produce false positives.
 */
export function validateCliOverrides(
	cli: CliOverrides,
): Partial<RalphConfigFile> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(cli)) {
		if (value === undefined) continue;
		cleaned[key] = value;
	}
	const result = CliOverridesSchema.safeParse(cleaned);
	if (!result.success) {
		throw new ConfigError(formatZodError(result.error, "CLI flags"));
	}
	return result.data;
}
