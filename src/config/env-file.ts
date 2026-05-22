import { join } from "node:path";
import { ZodError } from "zod";
import { ConfigError, formatZodError } from "./errors.js";
import { safeReadFile } from "./io.js";
import { type RalphSecrets, RalphSecretsSchema } from "./schema.js";

export const ENV_FILE_NAME = ".ralph/.env";

/**
 * Process-env vars Ralph pulls from the host environment as secret
 * overrides. Anything outside this whitelist is ignored — the OS env
 * carries `PATH`, `HOME`, etc. which have no business in the secrets
 * struct. To extend secrets with custom keys, add them to
 * `.ralph/.env` (the schema's `.passthrough()` accepts them).
 */
const KNOWN_SECRET_KEYS = [
	"WHATSAPP_PHONE",
	"WHATSAPP_APIKEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
] as const;

export type EnvFileReadResult = {
	readonly value: RalphSecrets;
	readonly source: "loaded" | "missing";
};

/**
 * Read `.ralph/.env`, merge with `process.env` (whitelist only),
 * validate against `RalphSecretsSchema`. Missing file is fine; an
 * invalid value (e.g. a malformed phone number) raises `ConfigError`.
 */
export async function readAndValidateEnvFile(
	cwd: string,
	processEnv: Readonly<Record<string, string | undefined>>,
): Promise<EnvFileReadResult> {
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

/**
 * Merge policy:
 *   - `.ralph/.env` is the source of truth for arbitrary keys (the
 *     schema's `.passthrough()` lets users add their own).
 *   - `process.env` is consulted ONLY for `KNOWN_SECRET_KEYS`, where
 *     it WINS over the file value (CI/secret-injection path).
 *   - Other `process.env` keys are deliberately ignored.
 */
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

/**
 * Minimal dotenv parser. Supports:
 *   - `KEY=value`
 *   - quoted values (`KEY="value"` or `KEY='value'`)
 *   - comments starting with `#`
 *   - blank lines
 * Lines without `=` are silently skipped (matches dotenv's tolerance).
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
