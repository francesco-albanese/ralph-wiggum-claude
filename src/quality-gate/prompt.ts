import { QG_OUTPUT_CLOSE, QG_OUTPUT_OPEN } from "./types.js";

export function buildQualityGatePrompt(args: {
	readonly command: string;
	readonly diff: string;
	readonly touchedBeads: ReadonlyArray<string>;
	readonly activeEpicId: string | undefined;
	readonly activeEpicNotes: string;
	readonly claudeRules: string;
	readonly baseBranch: string;
	readonly branch: string;
}): string {
	const touchedBeadsBlock =
		args.touchedBeads.length > 0
			? args.touchedBeads.map((b) => `- ${b}`).join("\n")
			: "(none)";
	const activeEpicBlock =
		args.activeEpicId !== undefined
			? `# Active epic: ${args.activeEpicId}\n\n${args.activeEpicNotes.trim()}`
			: "(no active epic)";
	const claudeRulesBlock =
		args.claudeRules.trim().length > 0 ? args.claudeRules.trim() : "(none)";

	return [
		args.command,
		"",
		"Use this Ralph context for the audit and final response.",
		"",
		`# Branch: ${args.branch}  →  base: ${args.baseBranch}`,
		"",
		"# Touched beads",
		touchedBeadsBlock,
		"",
		activeEpicBlock,
		"",
		"# Project rules (.claude/rules/*)",
		claudeRulesBlock,
		"",
		"# PR diff",
		"```diff",
		args.diff.trim(),
		"```",
		"",
		"# Output contract (REQUIRED)",
		"",
		`Emit EXACTLY one block between ${QG_OUTPUT_OPEN} and ${QG_OUTPUT_CLOSE} containing valid JSON:`,
		"",
		QG_OUTPUT_OPEN,
		"{",
		'  "pr": {',
		'    "subject": "<imperative 1-line subject, no prefix>",',
		'    "summary": "<exactly 2 sentences explaining what changed and why>",',
		'    "closedBeads": ["<bead-id>", ...]',
		"  },",
		'  "followUps": [',
		'    { "severity": "medium", "title": "<short>", "detail": "<optional>" }',
		"  ]",
		"}",
		QG_OUTPUT_CLOSE,
		"",
		"DO NOT include Ralph branding, token counts, or run metadata in the summary.",
	].join("\n");
}
