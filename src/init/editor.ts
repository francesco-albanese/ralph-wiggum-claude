import { spawn } from "node:child_process";
import { note } from "@clack/prompts";

/**
 * Spawn `$EDITOR <path>` and wait for it to exit. Falls back to a no-op
 * (with a note) when no editor is configured — running `ralph init`
 * unattended (CI, tests with `--no-editor`) shouldn't error out.
 *
 * stdio is inherited so terminal editors (vim, nano, helix) get the
 * user's TTY without ceremony. GUI editors typically return immediately
 * after spawning their window; for those, `--wait` (VSCode) or `-w`
 * (Sublime) is the user's responsibility to bake into `$EDITOR`.
 */
export async function openInEditor(path: string): Promise<void> {
	// `||` (not `??`) so a blank `EDITOR=` falls through to `$VISUAL`; trim
	// first so a whitespace-only value counts as unset too.
	const editor = process.env.EDITOR?.trim() || process.env.VISUAL?.trim();
	if (editor === undefined || editor.length === 0) {
		note(
			`No $EDITOR set — open ${path} manually to tailor the prompt.`,
			"editor",
		);
		return;
	}

	// `/bin/sh -c` so users can put flags in $EDITOR (`code --wait`,
	// `nvim -p`, etc.) without us re-parsing shell syntax.
	const cmd = `${editor} ${shellEscape(path)}`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", cmd], { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0 || code === null) {
				resolve();
				return;
			}
			reject(new Error(`editor exited with code ${code}`));
		});
	});
}

function shellEscape(s: string): string {
	// POSIX single-quote escape: wrap in single quotes, escape any embedded
	// single quote as '\''. Safe for arbitrary paths including spaces.
	return `'${s.replace(/'/g, "'\\''")}'`;
}
