import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import { formatZodError } from "./errors.js";
import {
	type AgentName,
	type RalphConfigFile,
	RalphConfigFileSchema,
	type RalphSecrets,
	RalphSecretsSchema,
} from "./schema.js";

export const CONFIG_FILE_NAME = ".ralph/ralph.config.json";
export const ENV_FILE_NAME = ".ralph/.env";

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

	const merged = mergeConfig(DEFAULT_CONFIG, fileResult.value, cliConfig);

	return {
		config: merged,
		secrets: envResult.value,
		sources: {
			configFile: fileResult.source,
			envFile: envResult.source,
		},
	};
}

/** Thrown when a config or secrets file fails validation. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

async function readAndValidateConfigFile(cwd: string): Promise<{
	readonly value: Partial<RalphConfigFile>;
	readonly source: "loaded" | "missing";
}> {
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

async function readAndValidateEnvFile(
	cwd: string,
	processEnv: Readonly<Record<string, string | undefined>>,
): Promise<{
	readonly value: RalphSecrets;
	readonly source: "loaded" | "missing";
}> {
	const path = join(cwd, ENV_FILE_NAME);
	const raw = await safeReadFile(path);
	const source: "loaded" | "missing" = raw === undefined ? "missing" : "loaded";

	const fromFile = raw === undefined ? {} : parseDotenv(raw);
	const merged = mergeSecrets(fromFile, processEnv);

	try {
		const value = RalphSecretsSchema.parse(merged);
		return { value, source };
	} catch (err) {
		if (err instanceof ZodError) {
			throw new ConfigError(formatZodError(err, ENV_FILE_NAME));
		}
		throw err;
	}
}

function validateCliOverrides(cli: CliOverrides): Partial<RalphConfigFile> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(cli)) {
		if (value === undefined) continue;
		cleaned[key] = value;
	}
	const result = RalphConfigFileSchema.safeParse(cleaned);
	if (!result.success) {
		throw new ConfigError(formatZodError(result.error, "CLI flags"));
	}
	return result.data;
}

function mergeConfig(
	defaults: typeof DEFAULT_CONFIG,
	fromFile: Partial<RalphConfigFile>,
	fromCli: Partial<RalphConfigFile>,
): ResolvedConfig {
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

function mergeSecrets(
	fromFile: Record<string, string>,
	processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const merged: Record<string, string> = { ...fromFile };
	for (const key of KNOWN_SECRET_KEYS) {
		const override = processEnv[key];
		if (override !== undefined && override.length > 0) {
			merged[key] = override;
		}
	}
	return merged;
}

const KNOWN_SECRET_KEYS = [
	"WHATSAPP_PHONE",
	"WHATSAPP_APIKEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
] as const;

async function safeReadFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") return undefined;
		throw err;
	}
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}

/**
 * Minimal dotenv parser. Supports:
 *   - `KEY=value`
 *   - quoted values (`KEY="value"` or `KEY='value'`)
 *   - comments starting with `#`
 *   - blank lines
 * Deliberately not pulling in the `dotenv` package: scope is tiny and
 * stability of behaviour matters more than feature completeness.
 */
function parseDotenv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (line.startsWith("#")) continue;

		const eq = line.indexOf("=");
		if (eq === -1) continue;

		const key = line.slice(0, eq).trim();
		if (key.length === 0) continue;

		let value = line.slice(eq + 1).trim();
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				value = value.slice(1, -1);
			}
		}
		out[key] = value;
	}
	return out;
}
