import { parseBranch } from "../branch.js";
import type { QgPrCopy } from "./types.js";

export function derivePrTitle(args: {
	readonly branch: string;
	readonly subject: string;
}): string {
	const parsed = parseBranch(args.branch);
	const prefix = parsed.prefix.replace(/\/$/, "");
	const subject = args.subject.trim();
	if (subject.length === 0) {
		throw new Error("quality gate produced an empty PR subject");
	}
	const colonAt = subject.indexOf(":");
	if (colonAt > 0) {
		const head = subject.slice(0, colonAt).trim().toLowerCase();
		if (head === prefix) {
			return `${prefix}: ${subject.slice(colonAt + 1).trim()}`;
		}
	}
	return `${prefix}: ${subject}`;
}

export function formatPrBody(pr: QgPrCopy): string {
	const summary = pr.summary.trim();
	if (summary.length === 0) {
		throw new Error("quality gate produced an empty PR summary");
	}
	const parts = [summary];
	if (pr.closedBeads.length > 0) {
		const bullets = pr.closedBeads.map((b) => `- ${b}`).join("\n");
		parts.push(`Closed beads:\n${bullets}`);
	}
	return parts.join("\n\n");
}
