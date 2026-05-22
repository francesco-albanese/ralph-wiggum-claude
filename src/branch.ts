/**
 * Branch-name validation for `ralph run --branch <name>`.
 *
 * Ralph requires every source branch to carry a semantic prefix so that
 * the GitHub side (PR titles, branch protection) can route by intent.
 * The slug is derived once and reused as the worktree directory name
 * under `.ralph/worktrees/<slug>/`.
 */

export const ALLOWED_BRANCH_PREFIXES = [
	"feat/",
	"fix/",
	"chore/",
	"docs/",
	"refactor/",
	"perf/",
	"test/",
	"style/",
] as const;

export type AllowedBranchPrefix = (typeof ALLOWED_BRANCH_PREFIXES)[number];

export type ParsedBranch = {
	readonly name: string;
	readonly prefix: AllowedBranchPrefix;
	readonly slug: string;
};

const PREFIX_LIST = ALLOWED_BRANCH_PREFIXES.join(", ");

// Characters git refuses (or chokes on) in branch names.
const FORBIDDEN_CHARS = /[~^:?*\[\\]/;

export function parseBranch(input: string): ParsedBranch {
	if (input.trim().length === 0) {
		throw new Error("--branch is required and may not be empty");
	}

	const prefix = ALLOWED_BRANCH_PREFIXES.find((p) => input.startsWith(p));
	if (prefix === undefined) {
		throw new Error(
			`--branch "${input}" must start with one of: ${PREFIX_LIST}`,
		);
	}

	const suffix = input.slice(prefix.length);
	if (suffix.length === 0) {
		throw new Error(
			`--branch "${input}" needs a non-empty name after the ${prefix} prefix`,
		);
	}

	if (/\s/.test(input)) {
		throw new Error(`--branch "${input}" may not contain whitespace`);
	}

	const bad = input.match(FORBIDDEN_CHARS);
	if (bad !== null) {
		throw new Error(
			`--branch "${input}" contains an invalid character: ${JSON.stringify(bad[0])}`,
		);
	}

	return { name: input, prefix, slug: slugifyBranch(input) };
}

// Collision-safe: percent-encodes `/` (and anything else encodeURIComponent
// treats as reserved) so distinct branches always produce distinct slugs.
// `feat/a-b` → `feat%2Fa-b`, `feat/a/b` → `feat%2Fa%2Fb`.
function slugifyBranch(name: string): string {
	return encodeURIComponent(name);
}
