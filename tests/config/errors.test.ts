import { describe, expect, it } from "vitest";
import { formatZodError } from "../../src/config/errors.js";
import {
	RalphConfigFileSchema,
	RalphSecretsSchema,
} from "../../src/config/schema.js";

describe("formatZodError", () => {
	it("includes the JSON path of the failing field", () => {
		const result = RalphConfigFileSchema.safeParse({ maxIter: -1 });
		expect(result.success).toBe(false);
		if (result.success) return;
		const formatted = formatZodError(result.error, ".ralph/ralph.config.json");
		expect(formatted).toContain("maxIter");
		expect(formatted).toContain(".ralph/ralph.config.json");
	});

	it("includes a suggestion listing valid enum values", () => {
		const result = RalphConfigFileSchema.safeParse({ defaultAgent: "qwen" });
		expect(result.success).toBe(false);
		if (result.success) return;
		const formatted = formatZodError(result.error, ".ralph/ralph.config.json");
		expect(formatted).toContain("defaultAgent");
		expect(formatted).toMatch(/claude/);
		expect(formatted).toMatch(/codex/);
	});

	it("includes nested array index in the JSON path", () => {
		const result = RalphConfigFileSchema.safeParse({
			feedbackLoop: ["pnpm test", ""],
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const formatted = formatZodError(result.error, ".ralph/ralph.config.json");
		expect(formatted).toContain("feedbackLoop[1]");
	});

	it("calls out forbidden-secret keys with a remediation hint", () => {
		const result = RalphConfigFileSchema.safeParse({ apiKey: "x" });
		expect(result.success).toBe(false);
		if (result.success) return;
		const formatted = formatZodError(result.error, ".ralph/ralph.config.json");
		expect(formatted).toContain("apiKey");
		expect(formatted.toLowerCase()).toContain(".ralph/.env");
	});

	it("reports multiple errors at once", () => {
		const result = RalphConfigFileSchema.safeParse({
			defaultAgent: "qwen",
			maxIter: -1,
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const formatted = formatZodError(result.error, ".ralph/ralph.config.json");
		expect(formatted).toContain("defaultAgent");
		expect(formatted).toContain("maxIter");
	});

	it("includes a numeric bound in the suggestion for too_small", () => {
		// Earlier assertions only checked the field name appeared. The
		// suggestion text itself ("must be > 0") was untested, so the
		// `suggest()` branch could silently regress to empty.
		const result = RalphConfigFileSchema.safeParse({ maxIter: -1 });
		expect(result.success).toBe(false);
		if (result.success) return;
		const formatted = formatZodError(result.error, ".ralph/ralph.config.json");
		expect(formatted).toMatch(/must be > 0/);
	});

	it("provides a format-check suggestion for invalid_string", () => {
		// invalid_string surfaces from custom regex failures (e.g.
		// WHATSAPP_PHONE in secrets). Exercise the branch via a regex
		// failure on the secrets schema so the suggestion is rendered.
		const result = RalphSecretsSchema.safeParse({
			WHATSAPP_PHONE: "+44 7123 456789",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const formatted = formatZodError(result.error, ".ralph/.env");
		expect(formatted).toContain("WHATSAPP_PHONE");
		expect(formatted).toMatch(/check the value format/);
	});
});
