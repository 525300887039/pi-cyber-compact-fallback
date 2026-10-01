/**
 * Prompt assembly and the fallback model call.
 *
 * The template tests pin the substitution semantics: one native pass, values inserted
 * verbatim. The routing tests pin the call itself: `streamSimple().result()` only, because
 * `complete()` bypasses the virtual-model router and takes api-specific options.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type ModelCaller, type SummaryResponse, buildSummaryPrompt, summarize } from "../src/summarize.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const STOP_RESPONSE: SummaryResponse = {
	content: [{ type: "text", text: "SUMMARY" }],
	usage: { input: 1, output: 1 },
	stopReason: "stop",
};

interface RecordedCall {
	model: unknown;
	context: unknown;
	options: Record<string, unknown>;
}

/**
 * A registry for a virtual model: `find` returns catalog metadata with the virtual API id,
 * and there is no `complete` at all, so any code path that reaches for it fails instead of
 * silently testing a call the real host would not route.
 */
function virtualRegistry(response: SummaryResponse = STOP_RESPONSE): { calls: RecordedCall[]; registry: ModelCaller } {
	const calls: RecordedCall[] = [];
	return {
		calls,
		registry: {
			find: (provider: string, modelId: string) => ({ provider, id: modelId, api: "pi-virtual", name: `${provider}/${modelId}` }),
			streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => {
				calls.push({ model, context, options });
				return { result: async () => response };
			},
		},
	};
}

function config(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
	return { ...DEFAULT_CONFIG, fallbackProvider: "test-provider", fallbackModel: "test-model", ...overrides };
}

test("a custom template replaces every placeholder occurrence", () => {
	const prompt = buildSummaryPrompt({
		conversationText: "CONV",
		previousSummary: "OLD",
		customInstructions: "FOCUS",
		template: "A {conversation} B {previousSummary} C {customInstructions} D {conversation}",
	});

	assert.equal(prompt, "A CONV B OLD C FOCUS D CONV");
});

test("missing template values become empty strings", () => {
	const prompt = buildSummaryPrompt({
		conversationText: "CONV",
		template: "[{conversation}][{previousSummary}][{customInstructions}]",
	});

	assert.equal(prompt, "[CONV][][]");
});

test("placeholders inside the inserted values stay literal", () => {
	// The old chained replaceAll rescanned its own output: the conversation's literal
	// `{previousSummary}` was then replaced with the old summary.
	const prompt = buildSummaryPrompt({
		conversationText: "keep {previousSummary} and {conversation} as text",
		previousSummary: "OLD",
		customInstructions: "keep {conversation} too",
		template: "{customInstructions}\n{previousSummary}\n{conversation}",
	});

	assert.equal(prompt, "keep {conversation} too\nOLD\nkeep {previousSummary} and {conversation} as text");
});

test("$-patterns in the inserted values are not expanded", () => {
	// String.replace expands `$&`, `$'`, `$$` and the backtick form when the replacement is a
	// string; a callback keeps them literal.
	const value = "a $& b $' c $` d $$ e";
	const prompt = buildSummaryPrompt({
		conversationText: value,
		previousSummary: value,
		customInstructions: value,
		template: "{conversation}\n{previousSummary}\n{customInstructions}",
	});

	assert.equal(prompt, [value, value, value].join("\n"));
});

test("unknown placeholders and near-misses are left alone", () => {
	const prompt = buildSummaryPrompt({
		conversationText: "CONV",
		template: "{conversation} {unknown} {conversations} {}",
	});

	assert.equal(prompt, "CONV {unknown} {conversations} {}");
});

test("a custom template without placeholders is used as-is", () => {
	const prompt = buildSummaryPrompt({ conversationText: "CONV", template: "Summarize this. No placeholders." });
	assert.equal(prompt, "Summarize this. No placeholders.");
});

test("the default template keeps its sections and omits the absent ones", () => {
	const full = buildSummaryPrompt({
		conversationText: "CONV",
		previousSummary: "OLD",
		customInstructions: "FOCUS",
		template: null,
	});
	assert.match(full, /^You are a conversation summarizer/);
	assert.match(full, /<previous-summary>\nOLD\n<\/previous-summary>/);
	assert.match(full, /<user-instructions>\nFOCUS\n<\/user-instructions>/);
	assert.match(full, /<conversation>\nCONV\n<\/conversation>/);

	const bare = buildSummaryPrompt({ conversationText: "CONV", template: null });
	assert.doesNotMatch(bare, /<previous-summary>|<user-instructions>/);
	assert.match(bare, /<conversation>\nCONV\n<\/conversation>/);
});

test("summarize succeeds without a thinking level through streamSimple alone", async () => {
	const { calls, registry } = virtualRegistry();
	const notifications: string[] = [];

	const outcome = await summarize({ messagesToSummarize: [] }, config(), {
		modelRegistry: registry,
		notify: (message) => notifications.push(message),
	});

	assert.equal(outcome?.summary, "SUMMARY");
	assert.deepEqual(notifications, []);
	assert.equal(calls.length, 1, "exactly one model call");
	assert.deepEqual(calls[0]?.model, { provider: "test-provider", id: "test-model", api: "pi-virtual", name: "test-provider/test-model" });
	assert.equal(calls[0]?.options.maxTokens, DEFAULT_CONFIG.maxSummaryTokens);
	assert.equal(calls[0]?.options.cacheRetention, "none");
	assert.equal(typeof calls[0]?.options.sessionId, "string");
	// No reasoning key at all when the config does not ask for one.
	assert.ok(!("reasoning" in (calls[0]?.options ?? {})), "reasoning must stay unset");
});

test("summarize passes the configured thinking level as reasoning", async () => {
	const { calls, registry } = virtualRegistry();

	const outcome = await summarize({ messagesToSummarize: [] }, config({ thinkingLevel: "high" }), {
		modelRegistry: registry,
		notify: () => {},
	});

	assert.equal(outcome?.summary, "SUMMARY");
	assert.equal(calls[0]?.options.reasoning, "high");
});

test("summarize still refuses a response that is not a stop", async () => {
	const { calls, registry } = virtualRegistry({ content: [{ type: "text", text: "PARTIAL" }], stopReason: "length" });
	const notifications: Array<{ message: string; level: string }> = [];

	const outcome = await summarize({ messagesToSummarize: [] }, config(), {
		modelRegistry: registry,
		notify: (message, level) => notifications.push({ message, level }),
	});

	assert.equal(outcome, undefined);
	assert.equal(calls.length, 1);
	assert.match(notifications.at(-1)?.message ?? "", /截断/);
});
