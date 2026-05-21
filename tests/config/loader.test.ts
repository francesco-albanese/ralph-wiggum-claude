import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONFIG_FILE_NAME,
	DEFAULT_CONFIG,
	ENV_FILE_NAME,
	loadConfig,
} from "../../src/config/loader.js";

describe("loadConfig", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ralph-config-"));
		await mkdir(join(dir, ".ralph"), { recursive: true });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeConfigFile(content: object): Promise<void> {
		await writeFile(
			join(dir, CONFIG_FILE_NAME),
			JSON.stringify(content, null, 2),
			"utf8",
		);
	}

	async function writeEnvFile(content: string): Promise<void> {
		await writeFile(join(dir, ENV_FILE_NAME), content, "utf8");
	}

	it("returns documented defaults when neither file is present", async () => {
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.secrets).toEqual({});
		expect(result.sources.configFile).toBe("missing");
		expect(result.sources.envFile).toBe("missing");
	});

	it("parses .ralph/ralph.config.json and merges over defaults", async () => {
		await writeConfigFile({ maxIter: 25, defaultModel: "opus" });
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.config.maxIter).toBe(25);
		expect(result.config.defaultModel).toBe("opus");
		// untouched fields keep defaults
		expect(result.config.defaultAgent).toBe(DEFAULT_CONFIG.defaultAgent);
		expect(result.config.branchPrefixes).toEqual(DEFAULT_CONFIG.branchPrefixes);
	});

	it("CLI overrides beat file values which beat defaults", async () => {
		await writeConfigFile({ maxIter: 25, defaultAgent: "codex" });
		const result = await loadConfig({
			cwd: dir,
			cliOverrides: { maxIter: 50 },
			env: {},
		});
		// CLI wins for maxIter
		expect(result.config.maxIter).toBe(50);
		// File wins over default for defaultAgent
		expect(result.config.defaultAgent).toBe("codex");
		// Default applies for completionSignal
		expect(result.config.completionSignal).toBe(
			DEFAULT_CONFIG.completionSignal,
		);
	});

	it("preserves explicit feedbackLoop override (undefined ≠ [])", async () => {
		await writeConfigFile({ feedbackLoop: ["pnpm check"] });
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.config.feedbackLoop).toEqual(["pnpm check"]);
	});

	it("leaves feedbackLoop undefined when absent (autodiscovery active)", async () => {
		await writeConfigFile({ maxIter: 5 });
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.config.feedbackLoop).toBeUndefined();
	});

	it("treats an empty feedbackLoop array as an explicit override (still bypasses autodiscovery)", async () => {
		await writeConfigFile({ feedbackLoop: [] });
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.config.feedbackLoop).toEqual([]);
	});

	it("CLI feedbackLoop override beats file value", async () => {
		await writeConfigFile({ feedbackLoop: ["from-file"] });
		const result = await loadConfig({
			cwd: dir,
			cliOverrides: { feedbackLoop: ["from-cli"] },
			env: {},
		});
		expect(result.config.feedbackLoop).toEqual(["from-cli"]);
	});

	it("surfaces JSON parse errors with the config file path", async () => {
		await writeFile(join(dir, CONFIG_FILE_NAME), "{ not json", "utf8");
		await expect(
			loadConfig({ cwd: dir, cliOverrides: {}, env: {} }),
		).rejects.toThrow(/ralph\.config\.json/);
	});

	it("rejects a config file with a secret key (committed-secret guard)", async () => {
		await writeConfigFile({ whatsappApikey: "leaked" });
		await expect(
			loadConfig({ cwd: dir, cliOverrides: {}, env: {} }),
		).rejects.toThrow(/whatsappApikey/);
	});

	it("rejects a config file with an unknown top-level key", async () => {
		await writeConfigFile({ frobnicate: 1 });
		await expect(
			loadConfig({ cwd: dir, cliOverrides: {}, env: {} }),
		).rejects.toThrow();
	});

	it("rejects an invalid CLI override (negative maxIter)", async () => {
		await expect(
			loadConfig({ cwd: dir, cliOverrides: { maxIter: -5 }, env: {} }),
		).rejects.toThrow(/maxIter/);
	});

	it("loads .env file into secrets (notify creds)", async () => {
		await writeEnvFile("WHATSAPP_PHONE=447123456789\nWHATSAPP_APIKEY=abc123\n");
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.secrets.WHATSAPP_PHONE).toBe("447123456789");
		expect(result.secrets.WHATSAPP_APIKEY).toBe("abc123");
		expect(result.sources.envFile).toBe("loaded");
	});

	it("process env overrides .ralph/.env values", async () => {
		await writeEnvFile("WHATSAPP_PHONE=447111111111\n");
		const result = await loadConfig({
			cwd: dir,
			cliOverrides: {},
			env: { WHATSAPP_PHONE: "447222222222" },
		});
		expect(result.secrets.WHATSAPP_PHONE).toBe("447222222222");
	});

	it("rejects invalid WHATSAPP_PHONE format in secrets", async () => {
		await writeEnvFile("WHATSAPP_PHONE=+44 7123 456789\n");
		await expect(
			loadConfig({ cwd: dir, cliOverrides: {}, env: {} }),
		).rejects.toThrow(/WHATSAPP_PHONE/);
	});

	it("ignores comments and blank lines in .env", async () => {
		await writeEnvFile(
			"# WhatsApp\nWHATSAPP_PHONE=447123456789\n\n# blank line above\n",
		);
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.secrets.WHATSAPP_PHONE).toBe("447123456789");
	});

	it("supports quoted values in .env", async () => {
		await writeEnvFile('WHATSAPP_APIKEY="quoted-value"\n');
		const result = await loadConfig({ cwd: dir, cliOverrides: {}, env: {} });
		expect(result.secrets.WHATSAPP_APIKEY).toBe("quoted-value");
	});
});
