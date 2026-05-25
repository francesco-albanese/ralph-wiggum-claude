import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProc } from "../proc.js";
import type { AgentProvider } from "../providers.js";
import { spawnQualityGateAgent } from "./agent.js";
import { isRecord, parseQgAgentOutput } from "./parse.js";
import type { QualityGatePorts } from "./types.js";

export type DefaultQualityGatePortsOptions = {
	readonly cwd: string;
	readonly repoRoot: string;
	readonly provider: AgentProvider;
};

const BEAD_ID_PATTERN = /\b([a-z][a-z0-9-]*-[a-z0-9]{2,8})\b/gi;

export function createDefaultQualityGatePorts(
	opts: DefaultQualityGatePortsOptions,
): QualityGatePorts {
	const { cwd, repoRoot, provider } = opts;

	return {
		command: provider.qualityGateCommand,

		captureDiff: async (input) => {
			const { stdout } = await runProc({
				cmd: "git",
				args: ["diff", `${input.baseBranch}..HEAD`],
				cwd,
			});
			return stdout;
		},

		listTouchedBeads: async (input) => {
			const { stdout } = await runProc({
				cmd: "git",
				args: ["log", `${input.baseBranch}..HEAD`, "--format=%B"],
				cwd,
			});
			const seen = new Set<string>();
			for (const match of stdout.matchAll(BEAD_ID_PATTERN)) {
				const id = match[1];
				if (id !== undefined) seen.add(id.toLowerCase());
			}
			return Array.from(seen);
		},

		readActiveEpicNotes: async () => readActiveEpicNotes(repoRoot),

		readClaudeRules: async () => {
			const rulesDir = join(repoRoot, ".claude", "rules");
			try {
				return await concatMarkdownTree(rulesDir);
			} catch {
				return "";
			}
		},

		runAgent: async ({ cwd: agentCwd, prompt }) => {
			const text = await spawnQualityGateAgent({
				cwd: agentCwd,
				prompt,
				provider,
			});
			return parseQgAgentOutput(text);
		},

		commitAutoFixes: async () => {
			const status = await runProc({
				cmd: "git",
				args: ["status", "--porcelain"],
				cwd,
			});
			if (status.stdout.trim().length === 0) return false;
			await runProc({ cmd: "git", args: ["add", "-A"], cwd });
			await runProc({
				cmd: "git",
				args: ["commit", "-m", "chore: quality gate auto-fix"],
				cwd,
			});
			return true;
		},

		pushBranch: async (input) => {
			await runProc({
				cmd: "git",
				args: ["push", "origin", input.branch],
				cwd,
			});
		},

		createFollowUpBead: async (args) => {
			const argv = [
				"create",
				"--type=task",
				"--title",
				args.title,
				"--description",
				args.detail,
				"--labels",
				"follow-up",
				"--json",
			];
			if (args.parentEpic !== undefined) {
				argv.push("--parent", args.parentEpic);
			}
			const { stdout } = await runProc({
				cmd: "bd",
				args: argv,
				cwd: repoRoot,
			});
			const parsed: unknown = JSON.parse(stdout || "{}");
			if (isRecord(parsed) && typeof parsed.id === "string") {
				return parsed.id;
			}
			throw new Error(
				`bd create returned no id (stdout=${stdout.slice(0, 200)})`,
			);
		},

		editPr: async ({ cwd: ghCwd, prUrl, title, body }) => {
			await runProc({
				cmd: "gh",
				args: ["pr", "edit", prUrl, "--title", title, "--body", body],
				cwd: ghCwd,
			});
		},
	};
}

async function readActiveEpicNotes(
	repoRoot: string,
): Promise<{ readonly id: string | undefined; readonly notes: string }> {
	try {
		const { stdout } = await runProc({
			cmd: "bd",
			args: ["list", "--type=epic", "--status=open", "--json"],
			cwd: repoRoot,
			allowNonZero: true,
		});
		const parsed: unknown = JSON.parse(stdout || "[]");
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return { id: undefined, notes: "" };
		}
		const first = parsed[0];
		if (!isRecord(first)) return { id: undefined, notes: "" };
		const rawId = first.id;
		const id = typeof rawId === "string" ? rawId : undefined;
		const desc = typeof first.description === "string" ? first.description : "";
		return { id, notes: desc };
	} catch {
		return { id: undefined, notes: "" };
	}
}

async function concatMarkdownTree(dir: string): Promise<string> {
	const parts: string[] = [];
	await walk(dir, dir, parts);
	return parts.join("\n\n");
}

async function walk(
	root: string,
	current: string,
	out: string[],
): Promise<void> {
	const entries = await readdir(current, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(current, entry.name);
		if (entry.isDirectory()) {
			await walk(root, full, out);
			continue;
		}
		if (!entry.name.endsWith(".md")) continue;
		const rel = full.slice(root.length + 1);
		const body = await readFile(full, "utf8");
		out.push(`## ${rel}\n\n${body.trim()}`);
	}
}
