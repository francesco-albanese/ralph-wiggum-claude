import { describe, expect, it, vi } from "vitest";
import {
	formatWhatsAppMessage,
	type WhatsAppNotification,
	WhatsAppNotifier,
} from "../notify.js";

const ZERO_COST = {
	inputUsd: 0,
	outputUsd: 0,
	cacheCreateUsd: 0,
	cacheReadUsd: 0,
	totalUsd: 0.1234,
};

const BASE_NOTIFICATION: WhatsAppNotification = {
	status: "complete",
	project: "ralph-wiggum-claude",
	branch: "feat/notify",
	prUrl: "https://github.com/franco/ralph/pull/1",
	iterations: 2,
	maxIter: 5,
	wallMs: 65_000,
	tasksDone: 2,
	tasksBlocked: 0,
	usage: {
		inputTokens: 1_200,
		outputTokens: 345,
		cacheCreateTokens: 0,
		cacheReadTokens: 0,
	},
	cost: ZERO_COST,
	done: ["Implement notifier", "Wire terminal summary"],
	qgFindings: "QG: no follow-ups",
};

describe("formatWhatsAppMessage", () => {
	it("renders COMPLETE with run metadata, done summaries, tokens, cost, and QG line", () => {
		const message = formatWhatsAppMessage(BASE_NOTIFICATION);

		expect(message).toContain("Ralph: success (COMPLETE)");
		expect(message).toContain("Project: ralph-wiggum-claude");
		expect(message).toContain("Branch: feat/notify");
		expect(message).toContain("PR: https://github.com/franco/ralph/pull/1");
		expect(message).toContain("Iterations: 2/5 in 1m 05s");
		expect(message).toContain("Tasks: done 2, blocked 0");
		expect(message).toContain("Tokens: in 1.2k, out 345");
		expect(message).toContain("Cost: $0.1234");
		expect(message).toContain("- Implement notifier");
		expect(message).toContain("QG: no follow-ups");
	});

	it("renders STALL as warning with stall reason", () => {
		const message = formatWhatsAppMessage({
			...BASE_NOTIFICATION,
			status: "stalled",
			stallReason: "max-iter",
			tasksDone: 0,
			tasksBlocked: 1,
			done: [],
			qgFindings: "QG: skipped",
		});

		expect(message).toContain("Ralph: warning (STALLED max-iter)");
		expect(message).toContain("Tasks: done 0, blocked 1");
		expect(message).toContain("- none");
		expect(message).toContain("QG: skipped");
	});

	it("truncates the done list to 10 entries with a tail when encoded text exceeds 1500 chars", () => {
		const done = Array.from(
			{ length: 14 },
			(_, i) => `Task ${i + 1} ${"x".repeat(160)}`,
		);

		const message = formatWhatsAppMessage({
			...BASE_NOTIFICATION,
			tasksDone: done.length,
			done,
		});

		expect(message).toContain("- Task 10");
		expect(message).not.toContain("- Task 11");
		expect(message).toContain("- +4 more");
	});
});

describe("WhatsAppNotifier", () => {
	it("silently skips when credentials are missing", async () => {
		const fetchSpy = vi.fn<typeof fetch>();
		const log = vi.fn();
		const notifier = new WhatsAppNotifier({ fetch: fetchSpy, log });

		await notifier.notify(BASE_NOTIFICATION);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it("POSTs URL-encoded CallMeBot params", async () => {
		const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
		const notifier = new WhatsAppNotifier({
			phone: "447123456789",
			apiKey: "abc123",
			fetch: fetchSpy,
		});

		await notifier.notify(BASE_NOTIFICATION);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(init?.method).toBe("POST");
		expect(url).toBeInstanceOf(URL);
		const calledUrl = url as URL;
		expect(calledUrl.searchParams.get("phone")).toBe("447123456789");
		expect(calledUrl.searchParams.get("apikey")).toBe("abc123");
		expect(calledUrl.searchParams.get("text")).toContain(
			"Ralph: success (COMPLETE)",
		);
	});

	it("uses a 10 second timeout and logs abort without throwing", async () => {
		vi.useFakeTimers();
		const log = vi.fn();
		const fetchSpy = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				}),
		);
		const notifier = new WhatsAppNotifier({
			phone: "447123456789",
			apiKey: "abc123",
			fetch: fetchSpy,
			log,
		});

		const pending = notifier.notify(BASE_NOTIFICATION);
		await vi.advanceTimersByTimeAsync(10_000);
		await pending;
		vi.useRealTimers();

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("WhatsApp notify failed: aborted"),
		);
	});

	it("logs non-2xx and network failures without throwing", async () => {
		const log = vi.fn();
		const httpFail = new WhatsAppNotifier({
			phone: "447123456789",
			apiKey: "abc123",
			fetch: vi.fn<typeof fetch>(
				async () => new Response("nope", { status: 500 }),
			),
			log,
		});
		const networkFail = new WhatsAppNotifier({
			phone: "447123456789",
			apiKey: "abc123",
			fetch: vi.fn<typeof fetch>(async () => {
				throw new Error("network down");
			}),
			log,
		});

		await expect(httpFail.notify(BASE_NOTIFICATION)).resolves.toBeUndefined();
		await expect(
			networkFail.notify(BASE_NOTIFICATION),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("WhatsApp notify failed: HTTP 500"),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("WhatsApp notify failed: network down"),
		);
	});
});
