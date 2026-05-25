import { describe, expect, it } from "vitest";
import { qualityGateDiffArgs, qualityGateLogArgs } from "./default-ports.js";

describe("quality gate git ranges", () => {
	it("uses merge-base semantics for the audited diff", () => {
		expect(qualityGateDiffArgs("main")).toEqual(["diff", "main...HEAD"]);
	});

	it("uses the HEAD side of the merge-base range for touched beads", () => {
		expect(qualityGateLogArgs("main")).toEqual([
			"log",
			"main...HEAD",
			"--right-only",
			"--format=%B",
		]);
	});
});
