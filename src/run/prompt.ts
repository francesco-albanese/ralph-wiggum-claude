import { join } from "node:path";
import {
	defaultShellRunner,
	loadAndRenderPrompt,
	type PromptContext,
} from "../prompt/preprocessor.js";

/**
 * Prompt the agent loop renders each iteration, relative to the host checkout.
 * Mirrors `RALPH_PATHS.prompt` in `src/init/plan.ts`; kept local so the run
 * path doesn't depend on the init module.
 */
const PROMPT_PATH = ".ralph/prompt.md";

export type LoadInvocationPromptOptions = {
	readonly repoRoot: string;
	readonly worktreeRoot: string;
	readonly context: PromptContext;
};

export async function loadInvocationPrompt(
	opts: LoadInvocationPromptOptions,
): Promise<string> {
	return await loadAndRenderPrompt(
		join(opts.repoRoot, PROMPT_PATH),
		opts.context,
		{
			runShell: (cmd, runOpts) =>
				defaultShellRunner(cmd, { ...runOpts, cwd: opts.worktreeRoot }),
		},
	);
}
