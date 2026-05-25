import type { CostBreakdown } from "../cost.js";
import type { IterationUsage } from "../stream.js";
import { fmtTokens, fmtUsd } from "../summary.js";

export type WhatsAppNotifyStatus = "complete" | "stalled";

export type WhatsAppNotification = {
	readonly status: WhatsAppNotifyStatus;
	readonly project: string;
	readonly branch: string;
	readonly prUrl: string;
	readonly iterations: number;
	readonly maxIter: number;
	readonly wallMs: number;
	readonly tasksDone: number;
	readonly tasksBlocked: number;
	readonly usage: IterationUsage;
	readonly cost: CostBreakdown;
	readonly done: ReadonlyArray<string>;
	readonly qgFindings: string;
	readonly stallReason?: "max-iter" | "crash-rate";
};

export type WhatsAppNotifierOptions = {
	readonly phone?: string;
	readonly apiKey?: string;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly log?: (msg: string) => void;
};

const CALLMEBOT_URL = "https://api.callmebot.com/whatsapp.php";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ENCODED_TEXT = 1_500;
const MAX_DONE_WHEN_TOO_LONG = 10;

export class WhatsAppNotifier {
	private readonly phone: string | undefined;
	private readonly apiKey: string | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly log: (msg: string) => void;

	constructor(opts: WhatsAppNotifierOptions = {}) {
		this.phone = opts.phone;
		this.apiKey = opts.apiKey;
		this.fetchImpl = opts.fetch ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));
	}

	async notify(input: WhatsAppNotification): Promise<void> {
		if (this.phone === undefined || this.apiKey === undefined) return;
		if (this.phone.length === 0 || this.apiKey.length === 0) return;

		const text = formatWhatsAppMessage(input);
		const url = new URL(CALLMEBOT_URL);
		url.searchParams.set("phone", this.phone);
		url.searchParams.set("apikey", this.apiKey);
		url.searchParams.set("text", text);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		timer.unref?.();

		try {
			const res = await this.fetchImpl(url, {
				method: "POST",
				signal: controller.signal,
			});
			if (!res.ok) {
				this.log(`ralph: WhatsApp notify failed: HTTP ${res.status}`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.log(`ralph: WhatsApp notify failed: ${msg}`);
		} finally {
			clearTimeout(timer);
		}
	}
}

export function formatWhatsAppMessage(input: WhatsAppNotification): string {
	const full = renderMessage(input, input.done);
	if (encodedTextLength(full) <= MAX_ENCODED_TEXT) return full;
	if (input.done.length <= MAX_DONE_WHEN_TOO_LONG) return full;

	const hidden = input.done.length - MAX_DONE_WHEN_TOO_LONG;
	const done = [
		...input.done.slice(0, MAX_DONE_WHEN_TOO_LONG),
		`+${hidden} more`,
	];
	return renderMessage(input, done);
}

function renderMessage(
	input: WhatsAppNotification,
	done: ReadonlyArray<string>,
): string {
	const status =
		input.status === "complete"
			? "success (COMPLETE)"
			: `warning (STALLED${input.stallReason !== undefined ? ` ${input.stallReason}` : ""})`;
	const prUrl = input.prUrl.length > 0 ? input.prUrl : "(none)";
	const lines = [
		`Ralph: ${status}`,
		`Project: ${input.project}`,
		`Branch: ${input.branch}`,
		`PR: ${prUrl}`,
		`Iterations: ${input.iterations}/${input.maxIter} in ${formatWallTime(
			input.wallMs,
		)}`,
		`Tasks: done ${input.tasksDone}, blocked ${input.tasksBlocked}`,
		`Tokens: in ${fmtTokens(input.usage.inputTokens)}, out ${fmtTokens(
			input.usage.outputTokens,
		)}`,
		`Cost: ${fmtUsd(input.cost.totalUsd)}`,
		"Done:",
		...(done.length > 0
			? done.map((item) => `- ${oneLine(item)}`)
			: ["- none"]),
		input.qgFindings,
	];
	return lines.join("\n");
}

function formatWallTime(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1_000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function oneLine(value: string): string {
	const firstLine = value.split(/\r?\n/u, 1)[0] ?? "";
	return firstLine.replace(/\s+/gu, " ").trim();
}

function encodedTextLength(text: string): number {
	return new URLSearchParams({ text }).toString().length;
}
