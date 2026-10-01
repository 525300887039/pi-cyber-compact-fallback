/**
 * Producing a compaction summary with the configured fallback model.
 *
 * This mirrors what pi does for its own summaries: the same serialization helper,
 * the same summary format, and `cacheRetention: "none"` because a summary prompt is
 * one-shot and would only pollute the prompt cache.
 */

import { type StopReason, uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import type { FallbackConfig } from "./types.ts";

/** Structural view of the pieces of `ModelRegistry` this module uses. */
export interface ModelCaller {
	find(provider: string, modelId: string): unknown;
	/** Provider-neutral call: it routes virtual models, unlike the api-specific `complete`. */
	streamSimple(model: unknown, context: unknown, options?: unknown): { result(): Promise<SummaryResponse> };
}

export interface SummaryResponse {
	content: Array<{ type: string; text?: string }>;
	usage?: unknown;
	/**
	 * pi-ai's completion contract. Only `"stop"` is a complete answer: `"length"` carries
	 * partial text, `"error"`/`"aborted"`/`"pending"` are unfinished, `"toolUse"`/`"deferred"`
	 * are not summaries. Anything else must never become a session checkpoint.
	 */
	stopReason: StopReason;
	/** Provider error text, set when `stopReason` is `"error"`. */
	errorMessage?: string;
}

export interface SummarizeDeps {
	modelRegistry: ModelCaller;
	notify(message: string, level: "info" | "warning" | "error"): void;
	signal?: AbortSignal;
}

/** The message shape pi expects for a summarization request. */
export interface SummaryMessages {
	messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
}

export interface SummarizeInput {
	messagesToSummarize: readonly unknown[];
	turnPrefixMessages?: readonly unknown[];
	previousSummary?: string;
	customInstructions?: string;
}

export interface SummarizeOutcome {
	summary: string;
	usage?: unknown;
}

const DEFAULT_PROMPT = [
	"You are a conversation summarizer for an AI coding agent.",
	"The summary you write replaces the conversation history, so it must contain everything needed to continue the work.",
	"",
	"Use exactly this markdown structure:",
	"",
	"## Goal",
	"[What the user is trying to accomplish]",
	"",
	"## Constraints & Preferences",
	"- [Requirements mentioned by the user]",
	"",
	"## Progress",
	"### Done",
	"- [x] [Completed tasks]",
	"",
	"### In Progress",
	"- [ ] [Current work]",
	"",
	"### Blocked",
	"- [Issues, if any]",
	"",
	"## Key Decisions",
	"- **[Decision]**: [Rationale]",
	"",
	"## Next Steps",
	"1. [What should happen next]",
	"",
	"## Critical Context",
	"- [Data needed to continue]",
	"",
	"Be thorough but concise. Preserve concrete identifiers: file paths, function names, commands, error messages and numbers.",
].join("\n");

/**
 * Mirrors pi's internal `computeFileLists` (not exported from the package): files that were
 * only read, versus files that were written or edited.
 */
export function computeFileLists(fileOps: {
	read?: Iterable<string>;
	written?: Iterable<string>;
	edited?: Iterable<string>;
}): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...(fileOps.edited ?? []), ...(fileOps.written ?? [])]);
	const readOnly = [...(fileOps.read ?? [])].filter((file) => !modified.has(file)).sort();
	return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

export function truncateMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const half = Math.floor((limit - 64) / 2);
	const omitted = text.length - half * 2;
	return `${text.slice(0, half)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(text.length - half)}`;
}

export function buildSummaryPrompt(input: {
	conversationText: string;
	previousSummary?: string;
	customInstructions?: string;
	template: string | null;
}): string {
	const parts: string[] = [];

	if (input.template) {
		// One native pass with a callback, not chained `replaceAll`: the values are inserted
		// verbatim (no `$&` / `$'` / `` $` `` / `$$` expansion) and are never rescanned, so a
		// conversation that quotes `{previousSummary}` stays literal instead of pulling in the
		// old summary. Missing values become empty strings; unknown placeholders stay as-is.
		const placeholder = /\{(conversation|previousSummary|customInstructions)\}/g;
		const values: Record<string, string> = {
			conversation: input.conversationText,
			previousSummary: input.previousSummary ?? "",
			customInstructions: input.customInstructions ?? "",
		};
		parts.push(input.template.replace(placeholder, (match, name: string) => values[name] ?? match));
		return parts.join("\n\n");
	}

	parts.push(DEFAULT_PROMPT);

	if (input.previousSummary) {
		parts.push(
			[
				"A previous summary of this session exists. Update it with the new conversation:",
				"keep facts that are still true, correct what changed, and drop what is obsolete.",
				"<previous-summary>",
				input.previousSummary,
				"</previous-summary>",
			].join("\n"),
		);
	}

	if (input.customInstructions) {
		parts.push(
			["The user asked for this summary to focus on:", "<user-instructions>", input.customInstructions, "</user-instructions>"].join(
				"\n",
			),
		);
	}

	parts.push(["<conversation>", input.conversationText, "</conversation>"].join("\n"));

	return parts.join("\n\n");
}

export function serializeForSummary(input: SummarizeInput, maxChars: number): string {
	const all = [...input.messagesToSummarize, ...(input.turnPrefixMessages ?? [])];
	// `convertToLlm` + `serializeConversation` are pi's own helpers: they produce the
	// "[User]: ... / [Assistant tool calls]: ..." transcript and truncate tool results.
	const text = serializeConversation(convertToLlm(all as Parameters<typeof convertToLlm>[0]));
	return truncateMiddle(text, maxChars);
}

function extractText(response: SummaryResponse): string {
	return response.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

/**
 * Mirrors pi's own `getSummarizationFailure` (not exported), but stricter: only `"stop"`
 * passes. A partial `"length"` answer is non-empty, so nothing may look at its text.
 */
function describeIncompleteResponse(response: SummaryResponse): { message: string; level: "warning" | "error" } | undefined {
	switch (response.stopReason) {
		case "stop":
			break;
		case "error":
			return { message: `摘要失败：${response.errorMessage || "未知错误"}`, level: "error" };
		case "length":
			return { message: "摘要达到 token 上限而被截断，内容不完整", level: "warning" };
		case "aborted":
			return { message: "摘要请求已被中止（aborted）", level: "warning" };
		case "pending":
			return { message: "摘要请求尚未完成（pending）", level: "warning" };
		case "toolUse":
			return { message: "摘要响应尝试调用工具（toolUse）", level: "warning" };
		default:
			return { message: `摘要未正常结束（stopReason=${String(response.stopReason)}）`, level: "warning" };
	}

	// pi rejects tool calls in a summary; a `"stop"` response can still carry one.
	if (response.content.some((part) => part.type === "toolCall")) {
		return { message: "摘要响应包含工具调用（toolCall）", level: "warning" };
	}

	return undefined;
}

export async function summarize(input: SummarizeInput, config: FallbackConfig, deps: SummarizeDeps): Promise<SummarizeOutcome | undefined> {
	const provider = config.fallbackProvider;
	const modelId = config.fallbackModel;

	if (!provider || !modelId) {
		deps.notify("未配置回退模型（fallbackProvider / fallbackModel），已放弃回退压缩", "warning");
		return undefined;
	}

	let model: unknown;
	try {
		model = deps.modelRegistry.find(provider, modelId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.notify(`查询回退模型 ${provider}/${modelId} 失败：${message}`, "error");
		return undefined;
	}
	if (!model) {
		deps.notify(`找不到回退模型 ${provider}/${modelId}，已放弃回退压缩`, "error");
		return undefined;
	}

	// Everything is inside the try: this function must never throw, because a throw from an
	// event handler leaves pi with no result and the caller's state machine armed forever.
	try {
		// An already-aborted signal means the request must not be sent at all. The signal is
		// checked again after the response, because a call that ignores cancellation (fake or
		// real) must not be able to persist a summary the user already cancelled.
		if (deps.signal?.aborted) {
			deps.notify(`回退模型 ${provider}/${modelId} 摘要请求在发出前已被取消，已放弃回退压缩`, "warning");
			return undefined;
		}

		const conversationText = serializeForSummary(input, config.maxConversationChars);
		const prompt = buildSummaryPrompt({
			conversationText,
			previousSummary: input.previousSummary,
			customInstructions: input.customInstructions,
			template: config.promptTemplate,
		});

		const messages: SummaryMessages = {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		};

		const baseOptions = {
			maxTokens: config.maxSummaryTokens,
			signal: deps.signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
		};

		// Always the provider-neutral simple stream. `complete()` takes api-specific options and
		// bypasses the virtual-model router, so a configured virtual model would fail there;
		// `streamSimple` accepts the same options and the optional `reasoning` level.
		const response = await deps.modelRegistry
			.streamSimple(model, messages, config.thinkingLevel ? { ...baseOptions, reasoning: config.thinkingLevel } : baseOptions)
			.result();

		if (deps.signal?.aborted) {
			deps.notify(`回退模型 ${provider}/${modelId} 摘要请求已被取消，丢弃返回的结果`, "warning");
			return undefined;
		}

		// Whatever text a non-complete answer carries is unusable as a checkpoint: a `length`
		// stop is a truncated summary, an `error` one may hold a partial paragraph.
		const failure = describeIncompleteResponse(response);
		if (failure) {
			deps.notify(`回退模型 ${provider}/${modelId} ${failure.message}，已放弃回退压缩`, failure.level);
			return undefined;
		}

		const summary = extractText(response);
		if (!summary) {
			deps.notify(`回退模型 ${provider}/${modelId} 返回空摘要，已放弃回退压缩`, "warning");
			return undefined;
		}

		return { summary, usage: response.usage };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.notify(`回退模型 ${provider}/${modelId} 摘要失败：${message}`, "error");
		return undefined;
	}
}
