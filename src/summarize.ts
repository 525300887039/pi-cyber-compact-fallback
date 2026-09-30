/**
 * Producing a compaction summary with the configured fallback model.
 *
 * This mirrors what pi does for its own summaries: the same serialization helper,
 * the same summary format, and `cacheRetention: "none"` because a summary prompt is
 * one-shot and would only pollute the prompt cache.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import type { FallbackConfig } from "./types.ts";

/** Structural view of the pieces of `ModelRegistry` this module uses. */
export interface ModelCaller {
	find(provider: string, modelId: string): unknown;
	complete(model: unknown, context: unknown, options?: unknown): Promise<SummaryResponse>;
	streamSimple(model: unknown, context: unknown, options?: unknown): { result(): Promise<SummaryResponse> };
}

export interface SummaryResponse {
	content: Array<{ type: string; text?: string }>;
	usage?: unknown;
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
		parts.push(
			input.template
				.replaceAll("{conversation}", input.conversationText)
				.replaceAll("{previousSummary}", input.previousSummary ?? "")
				.replaceAll("{customInstructions}", input.customInstructions ?? ""),
		);
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

		const response = config.thinkingLevel
			? await deps.modelRegistry
					.streamSimple(model, messages, { ...baseOptions, reasoning: config.thinkingLevel })
					.result()
			: await deps.modelRegistry.complete(model, messages, baseOptions);

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
