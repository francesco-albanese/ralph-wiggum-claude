import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultShellRunner } from "./preprocessor.js";

describe("defaultShellRunner", () => {
	it("runs a real command and captures stdout + exit code", async () => {
		const result = await defaultShellRunner("echo hello");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	it("returns the non-zero exit code and stderr from a failing command", async () => {
		const result = await defaultShellRunner("sh -c 'echo boom 1>&2; exit 3'");
		expect(result.exitCode).toBe(3);
		expect(result.stderr ?? "").toContain("boom");
	});

	it("runs commands in the supplied cwd", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ralph-shell-cwd-"));
		try {
			const result = await defaultShellRunner("pwd", { cwd });
			expect(result.exitCode).toBe(0);
			expect(realpathSync(result.stdout.trim())).toBe(realpathSync(cwd));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("kills a hung command and surfaces a timeout marker before the wall-clock blows up", async () => {
		const start = Date.now();
		const result = await defaultShellRunner("sleep 30", { timeoutMs: 200 });
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(3000);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr ?? "").toContain("timeout");
	});

	it("caps buffered stdout so a runaway command cannot OOM the host", async () => {
		const result = await defaultShellRunner(
			"head -c 1048576 /dev/zero | tr '\\0' 'a'",
			{ maxOutputBytes: 1024 },
		);

		expect(result.stdout.length).toBeLessThan(64 * 1024);
	});
});
