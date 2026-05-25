export type RunInitInput = {
	readonly cwd: string;
	readonly force: boolean;
	readonly openEditor: boolean;
};

/**
 * Interactive `ralph init` wizard. Stub — full implementation lands in
 * the next commit on this branch.
 */
export async function runInit(_input: RunInitInput): Promise<void> {
	throw new Error("ralph init: not implemented yet (work-in-progress)");
}
