import { describe, expect, it, vi } from "vitest";
import {
	buildQualityGatePrompt,
	derivePrTitle,
	formatPrBody,
	parseQgAgentOutput,
	QG_OUTPUT_CLOSE,
	QG_OUTPUT_OPEN,
	type QgAgentOutput,
	type QualityGatePorts,
	runQualityGate,
} from "./quality-gate.js";

function makePorts(
	overrides: Partial<QualityGatePorts> = {},
): QualityGatePorts {
	return {
		captureDiff: vi.fn(async () => "diff --git a/x b/x"),
		listTouchedBeads: vi.fn(async () => ["ralph-wiggum-claude-u61"]),
		readActiveEpicNotes: vi.fn(async () => ({
			id: "ralph-wiggum-claude-a84",
			notes: "Ralph v1 epic notes",
		})),
		readClaudeRules: vi.fn(async () => "## rules.md\n\nbe pragmatic"),
		runAgent: vi.fn(async () => ({
			pr: {
				subject: "wire the quality gate at COMPLETE",
				summary:
					"Add a single end-of-run gate. It rewrites the PR title/body and files follow-ups.",
				closedBeads: ["ralph-wiggum-claude-u61"],
			},
			followUps: [
				{ severity: "medium", title: "consider headless slash resolution" },
			],
		})) as QualityGatePorts["runAgent"],
		commitAutoFixes: vi.fn(async () => false),
		pushBranch: vi.fn(async () => {}),
		createFollowUpBead: vi.fn(async () => "ralph-wiggum-claude-fol"),
		editPr: vi.fn(async () => {}),
		...overrides,
	};
}

describe("derivePrTitle", () => {
	it("uses the branch's semantic prefix without the trailing slash", () => {
		expect(
			derivePrTitle({ branch: "feat/quality-gate", subject: "wire qg" }),
		).toBe("feat: wire qg");
		expect(
			derivePrTitle({ branch: "fix/oops", subject: "stop dropping events" }),
		).toBe("fix: stop dropping events");
		expect(derivePrTitle({ branch: "chore/tidy", subject: "tidy up" })).toBe(
			"chore: tidy up",
		);
	});

	it("strips a duplicated prefix the agent may have included", () => {
		// Agent emitted "feat: foo" despite the prompt — we must not produce
		// "feat: feat: foo" in the title.
		expect(
			derivePrTitle({ branch: "feat/foo", subject: "feat: ship the thing" }),
		).toBe("feat: ship the thing");
	});

	it("rejects an empty subject — QG must produce one", () => {
		expect(() => derivePrTitle({ branch: "feat/foo", subject: "   " })).toThrow(
			/empty PR subject/i,
		);
	});

	it("rejects an invalid branch prefix at the boundary", () => {
		// Defense in depth — orchestrate already validates, but the helper
		// is exported and pure, so it must reject too.
		expect(() => derivePrTitle({ branch: "wat/foo", subject: "wat" })).toThrow(
			/must start with one of/,
		);
	});
});

describe("formatPrBody", () => {
	it("emits the 2-sentence summary then a bullet list of closed beads", () => {
		const body = formatPrBody({
			subject: "irrelevant",
			summary:
				"Add a single end-of-run gate. It rewrites the PR title/body and files follow-ups.",
			closedBeads: ["ralph-wiggum-claude-u61", "ralph-wiggum-claude-a84"],
		});
		expect(body).toBe(
			[
				"Add a single end-of-run gate. It rewrites the PR title/body and files follow-ups.",
				"",
				"Closed beads:",
				"- ralph-wiggum-claude-u61",
				"- ralph-wiggum-claude-a84",
			].join("\n"),
		);
	});

	it("omits the bullet list when no beads were closed", () => {
		const body = formatPrBody({
			subject: "irrelevant",
			summary: "First sentence. Second sentence.",
			closedBeads: [],
		});
		expect(body).toBe("First sentence. Second sentence.");
		expect(body).not.toMatch(/closed beads/i);
	});

	it("never includes Ralph branding or run metadata", () => {
		// PRD: PR body is 2 sentences + closed beads list, nothing else.
		const body = formatPrBody({
			subject: "irrelevant",
			summary: "One. Two.",
			closedBeads: ["x-1"],
		});
		expect(body).not.toMatch(/ralph/i);
		expect(body).not.toMatch(/iteration/i);
		expect(body).not.toMatch(/token|cost/i);
	});

	it("rejects an empty summary", () => {
		expect(() =>
			formatPrBody({ subject: "x", summary: "  ", closedBeads: [] }),
		).toThrow(/empty PR summary/i);
	});
});

describe("parseQgAgentOutput", () => {
	const validJson = JSON.stringify({
		pr: {
			subject: "wire qg",
			summary: "First. Second.",
			closedBeads: ["x-1"],
		},
		followUps: [{ severity: "medium", title: "do the thing", detail: "later" }],
	});

	it("extracts the JSON block surrounded by the structured markers", () => {
		const text = `chatter\n${QG_OUTPUT_OPEN}\n${validJson}\n${QG_OUTPUT_CLOSE}\nmore chatter`;
		const out = parseQgAgentOutput(text);
		expect(out.pr.subject).toBe("wire qg");
		const first = out.followUps[0];
		expect(first?.severity).toBe("medium");
		expect(first?.detail).toBe("later");
	});

	it("uses the LAST opening marker so a quoted example earlier in the prompt is ignored", () => {
		// The agent's prompt itself contains the literal marker as an
		// example. The parser must lock onto the real (last) emission,
		// not the docs.
		const text = [
			`example: ${QG_OUTPUT_OPEN}{}${QG_OUTPUT_CLOSE}`,
			"actual output below:",
			`${QG_OUTPUT_OPEN}\n${validJson}\n${QG_OUTPUT_CLOSE}`,
		].join("\n");
		const out = parseQgAgentOutput(text);
		expect(out.pr.subject).toBe("wire qg");
	});

	it("throws when the opening marker is missing", () => {
		expect(() => parseQgAgentOutput("no marker here")).toThrow(
			/missing required <ralph-qg>/i,
		);
	});

	it("throws when the closing marker is missing", () => {
		expect(() => parseQgAgentOutput(`${QG_OUTPUT_OPEN}{...`)).toThrow(
			/missing closing/i,
		);
	});

	it("throws on malformed JSON inside the block", () => {
		const text = `${QG_OUTPUT_OPEN}{not json${QG_OUTPUT_CLOSE}`;
		expect(() => parseQgAgentOutput(text)).toThrow(/invalid JSON/i);
	});

	it("throws on an unknown severity value", () => {
		const bad = JSON.stringify({
			pr: { subject: "s", summary: "x.", closedBeads: [] },
			followUps: [{ severity: "WAT", title: "x" }],
		});
		expect(() =>
			parseQgAgentOutput(`${QG_OUTPUT_OPEN}${bad}${QG_OUTPUT_CLOSE}`),
		).toThrow(/severity must be one of/);
	});
});

describe("buildQualityGatePrompt", () => {
	it("includes the diff, touched beads, active epic, rules, and structured-output contract", () => {
		const prompt = buildQualityGatePrompt({
			diff: "DIFFDIFF",
			touchedBeads: ["b-1", "b-2"],
			activeEpicId: "epic-1",
			activeEpicNotes: "EPIC_NOTES",
			claudeRules: "RULES",
			baseBranch: "main",
			branch: "feat/foo",
		});

		expect(prompt).toContain("DIFFDIFF");
		expect(prompt).toContain("b-1");
		expect(prompt).toContain("b-2");
		expect(prompt).toContain("epic-1");
		expect(prompt).toContain("EPIC_NOTES");
		expect(prompt).toContain("RULES");
		expect(prompt).toContain("feat/foo");
		expect(prompt).toContain("main");
		expect(prompt).toContain(QG_OUTPUT_OPEN);
		expect(prompt).toContain(QG_OUTPUT_CLOSE);
	});

	it("renders sensible placeholders when there's no active epic or rules", () => {
		const prompt = buildQualityGatePrompt({
			diff: "d",
			touchedBeads: [],
			activeEpicId: undefined,
			activeEpicNotes: "",
			claudeRules: "",
			baseBranch: "main",
			branch: "feat/foo",
		});
		expect(prompt).toContain("(no active epic)");
		expect(prompt).toContain("(none)");
	});
});

describe("runQualityGate", () => {
	const INPUT = {
		cwd: "/tmp/wt",
		branch: "feat/foo",
		baseBranch: "main",
		prUrl: "https://github.com/x/y/pull/1",
	};

	it("files a follow-up bead per finding with the active epic as parent", async () => {
		const createFollowUpBead = vi.fn(async () => "ralph-wiggum-claude-new");
		const ports = makePorts({ createFollowUpBead });

		const report = await runQualityGate(ports, INPUT);

		expect(createFollowUpBead).toHaveBeenCalledTimes(1);
		expect(createFollowUpBead).toHaveBeenCalledWith({
			title: "consider headless slash resolution",
			detail: "",
			parentEpic: "ralph-wiggum-claude-a84",
		});
		expect(report.followUpBeadIds).toEqual(["ralph-wiggum-claude-new"]);
	});

	it("derives the PR title from the branch prefix and formats the body without Ralph metadata", async () => {
		const editPr = vi.fn(async () => {});
		const ports = makePorts({ editPr });

		const report = await runQualityGate(ports, INPUT);

		expect(report.prTitle).toBe("feat: wire the quality gate at COMPLETE");
		expect(report.prBody).toContain("Closed beads:");
		// "Ralph metadata" = tokens, cost, iteration counts, generated-by
		// banners. Bead IDs that happen to start with the project's "ralph-"
		// prefix are legitimate content, not branding.
		expect(report.prBody).not.toMatch(/iteration[s]?\s+\d+/i);
		expect(report.prBody).not.toMatch(/\b(tokens?|cost|generated by ralph)\b/i);
		expect(editPr).toHaveBeenCalledWith({
			cwd: "/tmp/wt",
			prUrl: "https://github.com/x/y/pull/1",
			title: report.prTitle,
			body: report.prBody,
		});
	});

	it("pushes the branch after auto-fixes are committed (but not when no fixes)", async () => {
		const pushBranch = vi.fn(async () => {});

		const noFixPorts = makePorts({
			commitAutoFixes: vi.fn(async () => false),
			pushBranch,
		});
		await runQualityGate(noFixPorts, INPUT);
		expect(pushBranch).not.toHaveBeenCalled();

		const fixPushed = vi.fn(async () => {});
		const fixPorts = makePorts({
			commitAutoFixes: vi.fn(async () => true),
			pushBranch: fixPushed,
		});
		const report = await runQualityGate(fixPorts, INPUT);
		expect(fixPushed).toHaveBeenCalledTimes(1);
		expect(report.autoFixCommitted).toBe(true);
	});

	it("propagates an agent failure so orchestrate can leave the PR draft", async () => {
		const ports = makePorts({
			runAgent: vi.fn(async () => {
				throw new Error("agent died");
			}) as QualityGatePorts["runAgent"],
		});
		await expect(runQualityGate(ports, INPUT)).rejects.toThrow(/agent died/);
	});

	it("still files follow-ups with parentEpic=undefined when no active epic resolves", async () => {
		const createFollowUpBead = vi.fn(async () => "x-1");
		const ports = makePorts({
			readActiveEpicNotes: vi.fn(async () => ({ id: undefined, notes: "" })),
			createFollowUpBead,
		});

		await runQualityGate(ports, INPUT);

		expect(createFollowUpBead).toHaveBeenCalledWith({
			title: "consider headless slash resolution",
			detail: "",
			parentEpic: undefined,
		});
	});

	it("forwards an agent output with zero follow-ups without filing beads", async () => {
		const createFollowUpBead = vi.fn(async () => "x-1");
		const agentOut: QgAgentOutput = {
			pr: { subject: "x", summary: "One. Two.", closedBeads: [] },
			followUps: [],
		};
		const ports = makePorts({
			runAgent: vi.fn(async () => agentOut) as QualityGatePorts["runAgent"],
			createFollowUpBead,
		});

		const report = await runQualityGate(ports, INPUT);

		expect(createFollowUpBead).not.toHaveBeenCalled();
		expect(report.followUpBeadIds).toEqual([]);
	});
});
