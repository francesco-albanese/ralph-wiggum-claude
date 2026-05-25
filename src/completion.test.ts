import { describe, expect, it } from "vitest";
import { createCompletionDetector } from "./completion.js";

describe("CompletionDetector", () => {
	it("matches the default completion signal when the chunk contains it", () => {
		const detector = createCompletionDetector();

		const before = detector.push("doing some work...");
		const onMatch = detector.push("done <promise>COMPLETE</promise> bye");

		expect(before).toBe(false);
		expect(onMatch).toBe(true);
	});

	it("uses a custom regex when one is provided", () => {
		const detector = createCompletionDetector({ pattern: /ALL_?DONE/i });

		expect(detector.push("nope nothing here")).toBe(false);
		expect(detector.push("status: all_done")).toBe(true);
	});

	it("does not match if the configured pattern never appears", () => {
		const detector = createCompletionDetector();

		expect(detector.push("just some chatter")).toBe(false);
		expect(detector.push("more chatter without the magic string")).toBe(false);
		expect(detector.matched).toBe(false);
	});

	it("matches the signal even when it is split across two chunks", () => {
		const detector = createCompletionDetector();

		const first = detector.push("...things ok <promise>COMP");
		const second = detector.push("LETE</promise> end");

		expect(first).toBe(false);
		expect(second).toBe(true);
		expect(detector.matched).toBe(true);
	});

	it("still matches after a long chaff stream (buffer stays bounded)", () => {
		const detector = createCompletionDetector();

		// Simulate ~1 MB of chaff in 100 KB chunks. With an unbounded
		// buffer this would be O(n²) per push and balloon memory; the
		// bounded tail keeps each push fast and finite.
		const chaff = "x".repeat(100_000);
		for (let i = 0; i < 10; i += 1) {
			expect(detector.push(chaff)).toBe(false);
		}

		// The sentinel arriving after the chaff must still be detected.
		expect(detector.push("done <promise>COMPLETE</promise>")).toBe(true);
		expect(detector.matched).toBe(true);
	});
});
