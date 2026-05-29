import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { loadBundledPricing } from "../cost.js";
import { openInEditor } from "./editor.js";
import { pathExists, safeReadFile, writeFileEnsuringDir } from "./io.js";
import {
	CUSTOM_MODEL_VALUE,
	defaultModelForAgent,
	modelOptionsForAgent,
} from "./models.js";
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

	const defaultModel = await pickModel(defaultAgent);
	if (defaultModel === undefined) return cancelAndExit();

	const maxIterRaw = await text({
		message: "Max iterations per invocation",
		placeholder: String(DEFAULT_CONFIG.maxIter),
		defaultValue: String(DEFAULT_CONFIG.maxIter),
		validate: (value) => {
			// clack runs validate against the raw input BEFORE substituting
			// `defaultValue` (which only happens on finalize). So empty input
			// must pass here — otherwise the user can't hit enter to accept
			// the default. A typed value still has to be a positive integer.
			const trimmed = (value ?? "").trim();
			if (trimmed.length === 0) return undefined;
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
		// No validate: empty input is intentionally allowed so the user can
		// hit enter to accept `defaultValue`. clack substitutes the default
		// on finalize, and `stringOr` coerces any stray empty string below.
		defaultValue: DEFAULT_CONFIG.completionSignal,
	});
	if (isCancel(completionSignal)) return cancelAndExit();

	return {
		defaultAgent,
		defaultModel,
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

/**
 * Agent-aware model prompt. Offers the pricing-table models for the chosen
 * agent as a `select()`, plus a "Custom…" option that drops to free-text
 * so a model not yet in pricing.json is never blocking. Returns the chosen
 * model id, or `undefined` if the user cancelled.
 */
async function pickModel(agent: AgentName): Promise<string | undefined> {
	const pricing = loadBundledPricing();
	const picked = await select<string>({
		message: "Default model",
		options: [...modelOptionsForAgent(agent, pricing)],
		initialValue: defaultModelForAgent(agent, pricing),
	});
	if (isCancel(picked)) return undefined;
	if (picked !== CUSTOM_MODEL_VALUE) return picked;

	const custom = await text({
		message: "Custom model id",
		placeholder: DEFAULT_CONFIG.defaultModel,
		validate: (value) =>
			(value ?? "").trim().length === 0 ? "Cannot be empty" : undefined,
	});
	if (isCancel(custom)) return undefined;
	return stringOr(custom, DEFAULT_CONFIG.defaultModel);
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
