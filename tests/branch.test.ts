import { describe, expect, it } from "vitest";
import { ALLOWED_BRANCH_PREFIXES, parseBranch } from "../src/branch.js";

describe("parseBranch", () => {
	describe("accepts every allowed semantic prefix", () => {
		for (const prefix of ALLOWED_BRANCH_PREFIXES) {
			it(`accepts ${prefix}example`, () => {
				const result = parseBranch(`${prefix}example`);
				expect(result.name).toBe(`${prefix}example`);
				expect(result.prefix).toBe(prefix);
			});
		}
	});

	it("slugifies the branch into a worktree-safe directory name", () => {
		const result = parseBranch("feat/some-feature");
		expect(result.slug).toBe("feat-some-feature");
	});

	it("collapses nested path segments into hyphens", () => {
		const result = parseBranch("feat/area/sub-task");
		expect(result.slug).toBe("feat-area-sub-task");
	});

	it("rejects branches with no slash", () => {
		expect(() => parseBranch("featbranch")).toThrow(/must start with one of:/);
	});

	it("rejects branches with an unknown prefix", () => {
		expect(() => parseBranch("random/foo")).toThrow(/must start with one of:/);
	});

	it("rejects empty branch names", () => {
		expect(() => parseBranch("")).toThrow();
	});

	it("rejects whitespace-only branches", () => {
		expect(() => parseBranch("   ")).toThrow();
	});

	it("rejects an empty suffix after the prefix", () => {
		expect(() => parseBranch("feat/")).toThrow(/non-empty name after the/);
	});

	it("rejects branches containing whitespace", () => {
		expect(() => parseBranch("feat/some thing")).toThrow(
			/may not contain whitespace/,
		);
	});

	it("rejects branches containing characters git refuses", () => {
		expect(() => parseBranch("feat/foo~bar")).toThrow(/invalid character/);
		expect(() => parseBranch("feat/foo:bar")).toThrow(/invalid character/);
		expect(() => parseBranch("feat/foo^bar")).toThrow(/invalid character/);
	});

	it("error message names the offending input", () => {
		expect(() => parseBranch("random/foo")).toThrow(/random\/foo/);
	});
});
