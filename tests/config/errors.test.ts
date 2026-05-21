import { describe, expect, it } from "vitest";
import { formatZodError } from "../../src/config/errors.js";
import { RalphConfigFileSchema } from "../../src/config/schema.js";

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
});
