import { describe, expect, it } from "vitest";
import {
	RalphConfigFileSchema,
	RalphSecretsSchema,
} from "../../src/config/schema.js";

describe("RalphConfigFileSchema", () => {
	it("accepts an empty object (all fields optional)", () => {
		expect(() => RalphConfigFileSchema.parse({})).not.toThrow();
	});

	it("accepts a full valid config", () => {
		const cfg = {
			defaultAgent: "claude",
			defaultModel: "sonnet",
			maxIter: 10,
			branchPrefixes: ["feat", "fix", "chore"],
			completionSignal: "<promise>COMPLETE</promise>",
			feedbackLoop: ["pnpm test", "pnpm typecheck"],
		};
		const parsed = RalphConfigFileSchema.parse(cfg);
		expect(parsed.feedbackLoop).toEqual(["pnpm test", "pnpm typecheck"]);
	});

	it("rejects unknown top-level keys (strict)", () => {
		const cfg = { defaultAgent: "claude", unknownField: 42 };
		expect(() => RalphConfigFileSchema.parse(cfg)).toThrow();
	});

	it("rejects unsupported agent name", () => {
		const cfg = { defaultAgent: "qwen" };
		expect(() => RalphConfigFileSchema.parse(cfg)).toThrow();
	});

	it("rejects non-positive maxIter", () => {
		expect(() => RalphConfigFileSchema.parse({ maxIter: 0 })).toThrow();
		expect(() => RalphConfigFileSchema.parse({ maxIter: -1 })).toThrow();
	});

	it("rejects empty branchPrefixes array", () => {
		expect(() => RalphConfigFileSchema.parse({ branchPrefixes: [] })).toThrow();
	});

	it("rejects empty-string entries in branchPrefixes", () => {
		expect(() =>
			RalphConfigFileSchema.parse({ branchPrefixes: ["feat", ""] }),
		).toThrow();
	});

	it("rejects empty completionSignal", () => {
		expect(() =>
			RalphConfigFileSchema.parse({ completionSignal: "" }),
		).toThrow();
	});

	it("rejects empty-string entries in feedbackLoop", () => {
		expect(() =>
			RalphConfigFileSchema.parse({ feedbackLoop: ["pnpm test", ""] }),
		).toThrow();
	});

	describe("secret guard", () => {
		it.each([
			["whatsappPhone", "447123456789"],
			["whatsappApikey", "secret"],
			["callmebotPhone", "447123456789"],
			["callmebotApikey", "secret"],
			["anthropicApiKey", "sk-ant-..."],
			["openaiApiKey", "sk-..."],
			["apiKey", "x"],
			["someToken", "x"],
			["mySecret", "x"],
		])("rejects committed secret key %s", (key, value) => {
			const cfg = { [key]: value };
			expect(() => RalphConfigFileSchema.parse(cfg)).toThrow();
		});
	});
});

describe("RalphSecretsSchema", () => {
	it("accepts an empty record (notify is opt-in)", () => {
		expect(() => RalphSecretsSchema.parse({})).not.toThrow();
	});

	it("accepts the full set of known secrets", () => {
		const env = {
			WHATSAPP_PHONE: "447123456789",
			WHATSAPP_APIKEY: "abc123",
			ANTHROPIC_API_KEY: "sk-ant-foo",
			OPENAI_API_KEY: "sk-foo",
		};
		const parsed = RalphSecretsSchema.parse(env);
		expect(parsed.WHATSAPP_PHONE).toBe("447123456789");
		expect(parsed.WHATSAPP_APIKEY).toBe("abc123");
	});

	it("rejects whatsapp phone with +/spaces (callmebot format)", () => {
		expect(() =>
			RalphSecretsSchema.parse({ WHATSAPP_PHONE: "+44 7123 456789" }),
		).toThrow();
	});

	it("passes through unknown env vars (the OS env contains arbitrary system vars)", () => {
		const parsed = RalphSecretsSchema.parse({
			WHATSAPP_PHONE: "447123456789",
			PATH: "/usr/bin",
			HOME: "/Users/x",
		});
		expect(parsed.WHATSAPP_PHONE).toBe("447123456789");
		// The schema doesn't strip arbitrary system vars — only the known
		// secret keys carry an enforced shape. Unknown vars are forwarded
		// untouched so a future feature can read them without rewiring the
		// loader.
	});
});
