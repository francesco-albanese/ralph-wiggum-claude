import { z } from "zod";

/**
 * Config + secrets schemas for Ralph.
 *
 * `RalphConfigFileSchema` validates the committed `.ralph/ralph.config.json`.
 * It is `.strict()` and explicitly forbids known-secret keys so a leaked
 * credential surfaces at parse time rather than after a `git push`.
 *
 * `RalphSecretsSchema` validates the secrets-only `.ralph/.env`, plus any
 * overriding `process.env` values. Unknown env vars are passthrough'd
 * because the OS env contains arbitrary system vars Ralph doesn't care
 * about — the schema only enforces shape on the keys it recognises.
 */

export const AGENT_NAMES = ["claude", "codex"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

const NonEmptyString = z.string().min(1);

/**
 * Forbidden top-level keys in the committed config file. These either
 * are secrets directly (CallMeBot creds, agent API keys) or carry the
 * shape of a secret (anything ending in Key/Token/Secret/Apikey, or
 * substrings like "phone"/"callmebot" that are well-known credential
 * surfaces in this codebase). Any of these in `ralph.config.json` is
 * a leak — the loader refuses to proceed so the developer notices
 * before a commit reaches origin.
 */
const FORBIDDEN_KEY_SUFFIXES = ["key", "token", "secret", "apikey"] as const;
const FORBIDDEN_KEY_SUBSTRINGS = ["phone", "callmebot"] as const;

function isForbiddenSecretKey(key: string): boolean {
	const lower = key.toLowerCase();
	if (FORBIDDEN_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
		return true;
	}
	return FORBIDDEN_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

const baseConfigShape = {
	defaultAgent: z.enum(AGENT_NAMES).optional(),
	defaultModel: NonEmptyString.optional(),
	maxIter: z.number().int().positive().optional(),
	branchPrefixes: z.array(NonEmptyString).min(1).optional(),
	completionSignal: NonEmptyString.optional(),
	feedbackLoop: z.array(NonEmptyString).optional(),
};

const baseConfigObject = z.object(baseConfigShape).strict();

/**
 * Schema for CLI-supplied overrides. Same shape as the config file but
 * WITHOUT the committed-secret guard. CLI flags come from a typed
 * `CliOverrides` object whose keys are fixed at compile time, so the
 * secret-scan can only ever produce false positives (e.g. a future
 * flag literally named `apiKey` would surface "looks like a secret;
 * move it to .ralph/.env" — confusing for a command-line input).
 */
export const CliOverridesSchema = baseConfigObject;

/**
 * Two-phase validation: first scan for known-secret-shaped keys and
 * emit a tailored "forbidden secret" issue (so the developer sees the
 * remediation hint), then run the strict object check to catch any
 * other unknown keys. Doing this in one schema via `superRefine` would
 * fire `unrecognized_keys` first and shadow the secret hint.
 */
export const RalphConfigFileSchema = z.preprocess((value, ctx) => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	const obj = value as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (key in baseConfigShape) continue;
		if (isForbiddenSecretKey(key)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [key],
				message: `"${key}" looks like a secret; move it to .ralph/.env (the committed config file must not contain credentials)`,
				params: { kind: "forbidden-secret" },
			});
		}
	}
	// Strip forbidden-secret keys so the downstream `.strict()` doesn't
	// re-emit them as `unrecognized_keys`, which would clutter the error
	// list and bury the secret-relocation hint.
	const cleaned: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(obj)) {
		if (key in baseConfigShape || !isForbiddenSecretKey(key)) {
			cleaned[key] = val;
		}
	}
	return cleaned;
}, baseConfigObject);

export type RalphConfigFile = z.infer<typeof RalphConfigFileSchema>;

/**
 * Phone numbers for CallMeBot are international digits only, no `+`,
 * no spaces (e.g. UK `07123 456789` → `447123456789`). We validate the
 * shape here so a typo surfaces at load time rather than as a silent
 * notify-skip.
 */
const PhoneNumber = z
	.string()
	.regex(/^[0-9]{7,15}$/u, "expected digits only, no '+' or spaces");

/**
 * `.passthrough()` lets users add arbitrary extra keys to `.ralph/.env`
 * (e.g. a future agent's auth token) without rewiring the schema. It
 * does NOT mean "ingest the entire OS environment" — the loader's
 * `mergeSecrets` deliberately only pulls a fixed whitelist of keys
 * from `process.env`, since the OS env is full of unrelated system
 * vars that have no business in our secrets struct.
 */
export const RalphSecretsSchema = z
	.object({
		WHATSAPP_PHONE: PhoneNumber.optional(),
		WHATSAPP_APIKEY: NonEmptyString.optional(),
		ANTHROPIC_API_KEY: NonEmptyString.optional(),
		OPENAI_API_KEY: NonEmptyString.optional(),
	})
	.passthrough();

export type RalphSecretsRaw = z.input<typeof RalphSecretsSchema>;
export type RalphSecrets = z.infer<typeof RalphSecretsSchema>;
