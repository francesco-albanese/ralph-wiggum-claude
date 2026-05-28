import { describe, expect, it } from "vitest";
import {
	type InitAnswers,
	planInit,
	RALPH_GITIGNORE_ENTRIES,
	RALPH_PATHS,
	upsertGitignoreEntries,
} from "./plan.js";

const ANSWERS: InitAnswers = {
	defaultAgent: "claude",
	defaultModel: "sonnet",
	maxIter: 10,
	branchPrefixes: ["feat", "fix"],
	completionSignal: "<promise>COMPLETE</promise>",
};

describe("planInit", () => {
	it("writes config, env example, and prompt with the documented paths", () => {
		const plan = planInit(ANSWERS, undefined);
		const paths = plan.writes.map((w) => w.path);
		expect(paths).toEqual([
			RALPH_PATHS.configFile,
			RALPH_PATHS.envExample,
			RALPH_PATHS.prompt,
		]);
	});

	it("serialises config with stable key order and trailing newline", () => {
		const plan = planInit(ANSWERS, undefined);
		const configWrite = plan.writes.find(
			(w) => w.path === RALPH_PATHS.configFile,
		);
		expect(configWrite).toBeDefined();
		const content = configWrite?.content ?? "";
		expect(content.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(content);
		expect(Object.keys(parsed)).toEqual([
			"defaultAgent",
			"defaultModel",
			"maxIter",
			"branchPrefixes",
			"completionSignal",
		]);
		expect(parsed.branchPrefixes).toEqual(["feat", "fix"]);
	});

	it("env example contains the WhatsApp secret keys (no leaked values)", () => {
		const plan = planInit(ANSWERS, undefined);
		const env = plan.writes.find((w) => w.path === RALPH_PATHS.envExample);
		const content = env?.content ?? "";
		for (const key of ["WHATSAPP_PHONE=", "WHATSAPP_APIKEY="]) {
			expect(content).toContain(key);
		}
		// Agent API keys are inert (never injected into the subprocess) so they
		// must NOT be scaffolded — see ralph-wiggum-claude-coh.
		expect(content).not.toContain("ANTHROPIC_API_KEY");
		expect(content).not.toContain("OPENAI_API_KEY");
		// No accidental values shipped
		expect(content).toMatch(/WHATSAPP_PHONE=\s*$/m);
	});

	it("prompt template uses {{KEY}} placeholders and shell expressions", () => {
		const plan = planInit(ANSWERS, undefined);
		const prompt = plan.writes.find((w) => w.path === RALPH_PATHS.prompt);
		const content = prompt?.content ?? "";
		expect(content).toContain("{{BRANCH}}");
		expect(content).toContain("{{TARGET_BRANCH}}");
		// Sandcastle-style shell expression: `!`cmd``
		expect(content).toMatch(/!`bd ready/);
		expect(content).toMatch(/!`git log/);
	});
});

describe("upsertGitignoreEntries", () => {
	it("creates a fresh section when .gitignore is missing", () => {
		const out = upsertGitignoreEntries(undefined, RALPH_GITIGNORE_ENTRIES);
		expect(out).toContain("# Ralph runtime");
		for (const entry of RALPH_GITIGNORE_ENTRIES) {
			expect(out).toContain(entry);
		}
		expect(out.endsWith("\n")).toBe(true);
	});

	it("appends entries to an existing .gitignore with a blank-line separator", () => {
		const existing = "node_modules/\ndist/\n";
		const out = upsertGitignoreEntries(existing, RALPH_GITIGNORE_ENTRIES);
		expect(out.startsWith("node_modules/\ndist/\n\n# Ralph runtime\n")).toBe(
			true,
		);
	});

	it("is idempotent — re-running does not duplicate entries", () => {
		const first = upsertGitignoreEntries(undefined, RALPH_GITIGNORE_ENTRIES);
		const second = upsertGitignoreEntries(first, RALPH_GITIGNORE_ENTRIES);
		expect(second).toBe(first);
	});

	it("scrubs overbroad .ralph/.env* wildcard so .env.example is committable", () => {
		const existing = "node_modules/\n.ralph/.env*\n.ralph/worktrees/\n";
		const out = upsertGitignoreEntries(existing, RALPH_GITIGNORE_ENTRIES);
		expect(out).not.toContain(".ralph/.env*");
		expect(out).toContain(".ralph/.env\n");
		// Wildcard scrub preserves the entries that were already correct
		expect(out).toContain(".ralph/worktrees/");
	});

	it("scrubs .ralph/.env.* variant as well", () => {
		const existing = ".ralph/.env.*\n";
		const out = upsertGitignoreEntries(existing, RALPH_GITIGNORE_ENTRIES);
		expect(out).not.toContain(".ralph/.env.*");
		expect(out).toContain(".ralph/.env\n");
	});

	it("splices missing entries into an existing Ralph section (no second header)", () => {
		const existing =
			"node_modules/\n\n# Ralph runtime\n.ralph/.env\n.ralph/worktrees/\n";
		const out = upsertGitignoreEntries(existing, RALPH_GITIGNORE_ENTRIES);
		const headerOccurrences = out.match(/# Ralph runtime/g);
		expect(headerOccurrences?.length).toBe(1);
		expect(out).toContain(".ralph/state/");
		expect(out).toContain(".ralph/logs/");
	});

	it("preserves the trailing newline convention", () => {
		const out1 = upsertGitignoreEntries("foo\n", RALPH_GITIGNORE_ENTRIES);
		expect(out1.endsWith("\n")).toBe(true);
		const out2 = upsertGitignoreEntries("foo", RALPH_GITIGNORE_ENTRIES);
		expect(out2.endsWith("\n")).toBe(true);
	});

	it("removes only the overbroad wildcard when all other entries are already present", () => {
		const existing = [
			"# Ralph runtime",
			".ralph/.env*",
			".ralph/.env",
			".ralph/state/",
			".ralph/logs/",
			".ralph/worktrees/",
			"",
		].join("\n");
		const out = upsertGitignoreEntries(existing, RALPH_GITIGNORE_ENTRIES);
		expect(out).not.toContain(".ralph/.env*");
		expect(out).toContain(".ralph/.env\n");
	});
});
