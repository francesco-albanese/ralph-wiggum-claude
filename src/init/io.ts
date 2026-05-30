import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Filesystem helpers for the `ralph init` scaffolder. Kept in a sibling
 * module so `index.ts` stays focused on the wizard flow.
 *
 * NOTE: `safeReadFile`/`isNodeErrnoException` mirror near-identical helpers
 * in `src/config/io.ts` and `src/prompt/preprocessor.ts`. Consolidating them
 * into one shared module is tracked separately — see the follow-up bead.
 */

/**
 * Write `content` to `target`, creating any missing parent directories.
 */
export async function writeFileEnsuringDir(
	target: string,
	content: string,
): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
}

/**
 * Read a UTF-8 file, returning `undefined` when it does not exist. Other
 * errors (e.g. permission denied) bubble up unchanged.
 */
export async function safeReadFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if (isNodeErrnoException(err) && err.code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * Report whether `path` exists on disk.
 */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err) {
		if (isNodeErrnoException(err) && err.code === "ENOENT") return false;
		throw err;
	}
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return (
		err instanceof Error &&
		typeof (err as NodeJS.ErrnoException).code === "string"
	);
}
