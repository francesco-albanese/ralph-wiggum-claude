/**
 * The default completion signal pattern emitted by the agent
 * to indicate "no more beads ready, end the invocation". Defined
 * in CONTEXT.md as the canonical sentinel.
 */
export const DEFAULT_COMPLETE_SIGNAL = "<promise>COMPLETE</promise>";

/**
 * Floor on the retained buffer tail. Big enough to span the default
 * sentinel comfortably and absorb a realistic chunked stream from
 * the agent without re-scanning megabytes on each push.
 */
const MIN_BUFFER_TAIL = 4_096;

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
	// Cap the retained buffer to MIN_BUFFER_TAIL OR the pattern length
	// (whichever is larger). Bounds memory on long streams and keeps
	// per-chunk match work O(maxTail) instead of O(stream length).
	const patternLen =
		typeof pattern === "string" ? pattern.length : pattern.source.length;
	const maxTail = Math.max(MIN_BUFFER_TAIL, patternLen);

	let buffer = "";
	let matched = false;

	return {
		push(chunk: string): boolean {
			if (matched) return true;
			buffer = (buffer + chunk).slice(-maxTail);
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
