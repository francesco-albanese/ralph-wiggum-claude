/**
 * The default completion signal pattern emitted by the agent
 * to indicate "no more beads ready, end the invocation". Defined
 * in CONTEXT.md as the canonical sentinel.
 */
export const DEFAULT_COMPLETE_SIGNAL = "<promise>COMPLETE</promise>";

export interface CompletionDetector {
	/**
	 * Feed a chunk of agent text. Returns true on the first chunk
	 * whose buffered tail (this chunk + a small carry-over from the
	 * previous chunk) matches the configured pattern. Subsequent
	 * pushes after a match keep returning true — the detector is
	 * sticky once it fires.
	 */
	push(chunk: string): boolean;
	/** Has the signal matched on any prior push? */
	readonly matched: boolean;
}

export interface CompletionDetectorOptions {
	/**
	 * Override the default `<promise>COMPLETE</promise>` sentinel
	 * with a custom regular expression (`--complete-signal`).
	 */
	readonly pattern?: RegExp;
}

export function createCompletionDetector(
	options: CompletionDetectorOptions = {},
): CompletionDetector {
	const pattern = options.pattern ?? DEFAULT_COMPLETE_SIGNAL;
	let buffer = "";
	let matched = false;

	return {
		push(chunk: string): boolean {
			if (matched) return true;
			buffer += chunk;
			const hit =
				typeof pattern === "string"
					? buffer.includes(pattern)
					: pattern.test(buffer);
			if (hit) {
				matched = true;
				return true;
			}
			return false;
		},
		get matched() {
			return matched;
		},
	};
}
