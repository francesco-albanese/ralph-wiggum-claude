import { derivePrTitle, formatPrBody } from "./quality-gate/copy.js";
import { buildQualityGatePrompt } from "./quality-gate/prompt.js";
import type {
	QualityGateInput,
	QualityGatePorts,
	QualityGateReport,
} from "./quality-gate/types.js";

export { derivePrTitle, formatPrBody } from "./quality-gate/copy.js";
export { createDefaultQualityGatePorts } from "./quality-gate/default-ports.js";
export { parseQgAgentOutput } from "./quality-gate/parse.js";
export { buildQualityGatePrompt } from "./quality-gate/prompt.js";
export {
	QG_OUTPUT_CLOSE,
	QG_OUTPUT_OPEN,
	type QgAgentOutput,
	type QgFinding,
	type QgPrCopy,
	type QgSeverity,
	type QualityGateInput,
	type QualityGatePorts,
	type QualityGateReport,
} from "./quality-gate/types.js";

export async function runQualityGate(
	ports: QualityGatePorts,
	input: QualityGateInput,
): Promise<QualityGateReport> {
	const [diff, touchedBeads, activeEpic, claudeRules] = await Promise.all([
		ports.captureDiff(input),
		ports.listTouchedBeads(input),
		ports.readActiveEpicNotes(),
		ports.readClaudeRules(),
	]);

	const prompt = buildQualityGatePrompt({
		command: ports.command,
		diff,
		touchedBeads,
		activeEpicId: activeEpic.id,
		activeEpicNotes: activeEpic.notes,
		claudeRules,
		baseBranch: input.baseBranch,
		branch: input.branch,
	});

	const agentOut = await ports.runAgent({ cwd: input.cwd, prompt });

	const autoFixCommitted = await ports.commitAutoFixes(input);
	if (autoFixCommitted) {
		await ports.pushBranch(input);
	}

	const followUpBeadIds: string[] = [];
	for (const finding of agentOut.followUps) {
		if (finding.severity === "high") {
			throw new Error(
				"quality gate returned a high-severity follow-up; high findings must be auto-fixed before passing",
			);
		}
		const beadId = await ports.createFollowUpBead({
			title: finding.title,
			detail: finding.detail ?? "",
			parentEpic: activeEpic.id,
		});
		followUpBeadIds.push(beadId);
	}

	const prTitle = derivePrTitle({
		branch: input.branch,
		subject: agentOut.pr.subject,
	});
	const prBody = formatPrBody(agentOut.pr);

	await ports.editPr({
		cwd: input.cwd,
		prUrl: input.prUrl,
		title: prTitle,
		body: prBody,
	});

	return { prTitle, prBody, followUpBeadIds, autoFixCommitted };
}
