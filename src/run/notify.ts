import { basename } from "node:path";
import { loadConfig } from "../config/loader.js";
import type { CostCalculator, EMPTY_USAGE } from "../cost.js";
import { type WhatsAppNotification, WhatsAppNotifier } from "../notify.js";
import type { OrchestrationResult } from "./orchestrate.js";

export async function notifyTerminalState(args: {
	readonly repoRoot: string;
	readonly branch: string;
	readonly maxIter: number;
	readonly wallMs: number;
	readonly result: OrchestrationResult;
	readonly totalUsage: typeof EMPTY_USAGE;
	readonly totalCost: ReturnType<CostCalculator["total"]>;
}): Promise<void> {
	let secrets:
		| {
				readonly WHATSAPP_PHONE?: string;
				readonly WHATSAPP_APIKEY?: string;
		  }
		| undefined;
	try {
		secrets = (
			await loadConfig({
				cwd: args.repoRoot,
				cliOverrides: {},
				env: Reflect.get(process, "env") as NodeJS.ProcessEnv,
			})
		).secrets;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`ralph: WhatsApp notify failed: ${msg}\n`);
		return;
	}

	const notifier = new WhatsAppNotifier({
		phone: secrets.WHATSAPP_PHONE,
		apiKey: secrets.WHATSAPP_APIKEY,
	});
	await notifier.notify(buildWhatsAppNotification(args));
}

export function buildWhatsAppNotification(args: {
	readonly repoRoot: string;
	readonly branch: string;
	readonly maxIter: number;
	readonly wallMs: number;
	readonly result: OrchestrationResult;
	readonly totalUsage: typeof EMPTY_USAGE;
	readonly totalCost: ReturnType<CostCalculator["total"]>;
}): WhatsAppNotification {
	const done = args.result.qualityGate?.prTitle
		? [args.result.qualityGate.prTitle]
		: [];
	const tasksBlocked =
		args.result.outcome === "stalled" || args.result.qgError !== undefined
			? 1
			: (args.result.qualityGate?.followUpBeadIds.length ?? 0);
	return {
		status: args.result.outcome === "complete" ? "complete" : "stalled",
		project: basename(args.repoRoot),
		branch: args.branch,
		prUrl: args.result.prUrl,
		iterations: args.result.iterations,
		maxIter: args.maxIter,
		wallMs: args.wallMs,
		tasksDone: done.length,
		tasksBlocked,
		usage: args.totalUsage,
		cost: args.totalCost,
		done,
		qgFindings: formatQGFindings(args.result),
		...(args.result.stallReason !== undefined
			? { stallReason: args.result.stallReason }
			: {}),
	};
}

function formatQGFindings(result: OrchestrationResult): string {
	if (result.qgError !== undefined) return "QG: failed - see PR/logs";
	if (result.qualityGate === undefined) return "QG: skipped";
	const followUps = result.qualityGate.followUpBeadIds;
	const autoFix = result.qualityGate.autoFixCommitted
		? ", auto-fix committed"
		: "";
	if (followUps.length === 0) return `QG: no follow-ups${autoFix}`;
	return `QG: ${followUps.length} follow-up(s) ${followUps.join(", ")}${autoFix}`;
}
