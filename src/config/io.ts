import { readFile } from "node:fs/promises";

/**
 * Read a UTF-8 file, returning `undefined` for ENOENT. Other errors
 * bubble up unchanged — the goal is "missing file is not an error,
 * permission denied IS".
 */
export async function safeReadFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if (isNodeError(err) && err.code === "ENOENT") return undefined;
		throw err;
	}
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}
