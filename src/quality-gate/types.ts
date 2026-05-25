export const QG_OUTPUT_OPEN = "<ralph-qg>";
export const QG_OUTPUT_CLOSE = "</ralph-qg>";

export type QgSeverity = "high" | "medium" | "low";

export type QgFinding = {
	readonly severity: QgSeverity;
	readonly title: string;
	readonly detail?: string;
};

export type QgPrCopy = {
	readonly subject: string;
	readonly summary: string;
	readonly closedBeads: ReadonlyArray<string>;
};

export type QgAgentOutput = {
	readonly pr: QgPrCopy;
	readonly followUps: ReadonlyArray<QgFinding>;
};

export type QualityGateInput = {
	readonly cwd: string;
	readonly branch: string;
	readonly baseBranch: string;
	readonly prUrl: string;
};

export type QualityGatePorts = {
	readonly command: string;
	readonly captureDiff: (input: QualityGateInput) => Promise<string>;
	readonly listTouchedBeads: (
		input: QualityGateInput,
	) => Promise<readonly string[]>;
	readonly readActiveEpicNotes: () => Promise<{
		readonly id: string | undefined;
		readonly notes: string;
	}>;
	readonly readClaudeRules: () => Promise<string>;
	readonly runAgent: (args: {
		readonly cwd: string;
		readonly prompt: string;
	}) => Promise<QgAgentOutput>;
	readonly commitAutoFixes: (input: QualityGateInput) => Promise<boolean>;
	readonly pushBranch: (input: QualityGateInput) => Promise<void>;
	readonly createFollowUpBead: (args: {
		readonly title: string;
		readonly detail: string;
		readonly parentEpic: string | undefined;
	}) => Promise<string>;
	readonly editPr: (args: {
		readonly cwd: string;
		readonly prUrl: string;
		readonly title: string;
		readonly body: string;
	}) => Promise<void>;
};

export type QualityGateReport = {
	readonly prTitle: string;
	readonly prBody: string;
	readonly followUpBeadIds: ReadonlyArray<string>;
	readonly autoFixCommitted: boolean;
};
