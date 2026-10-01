/**
 * Wiring tests: the real handlers, driven through a fake pi and a fake ExtensionContext.
 *
 * These cover what the pure unit tests cannot: which events trigger which recovery path,
 * what the handlers return, and that a failing fallback model cancels instead of letting
 * pi fall back to the default summarizer that just refused.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

import cyberCompactFallback from "../extensions/index.ts";

const CYBER_MESSAGE = "Compaction failed: bad response status code 400, upstream code: cyber_policy";

const roots: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

interface Recorded {
	notifications: Array<{ message: string; level: string }>;
	compactCalls: Array<Record<string, unknown>>;
	/** Model requests actually issued, so a test can prove a cancelled one was never sent. */
	modelCalls: number;
	/** Options of every `streamSimple` call, so routing and reasoning can be asserted. */
	streamOptions: Array<Record<string, unknown>>;
}

interface CtxOptions {
	/** Boolean, or a function so a test can flip idleness between polls. */
	idle?: boolean | (() => boolean);
	summary?: string | Error;
	/** Full fake `AssistantMessage`, for exercising stopReason/errorMessage handling. */
	response?: Record<string, unknown>;
	/** Full control of the model call, e.g. a deferred that settles after the deadline. */
	respond?: () => Promise<unknown>;
	/** Runs inside the model call, e.g. to abort the signal mid-request. */
	beforeRespond?: () => void;
	findThrows?: boolean;
}

function makeCtx(cwd: string, options: CtxOptions = {}): { ctx: any; recorded: Recorded } {
	const recorded: Recorded = { notifications: [], compactCalls: [], modelCalls: 0, streamOptions: [] };
	const summary = options.summary ?? "SUMMARY";

	// Only a complete `stop` may be persisted, so every normal fake says so explicitly.
	const respond = async (): Promise<unknown> => {
		recorded.modelCalls += 1;
		if (options.respond) return options.respond();
		if (summary instanceof Error) throw summary;
		options.beforeRespond?.();
		if (options.response) return options.response;
		return { content: [{ type: "text", text: summary }], usage: { input: 1, output: 1 }, stopReason: "stop" };
	};

	const ctx = {
		cwd,
		signal: undefined,
		isIdle: () => (typeof options.idle === "function" ? options.idle() : options.idle ?? true),
		ui: {
			notify: (message: string, level: string) => {
				recorded.notifications.push({ message, level });
			},
		},
		compact: (opts: Record<string, unknown>) => {
			recorded.compactCalls.push(opts);
		},
		modelRegistry: {
			find: (provider: string, modelId: string) => {
				if (options.findThrows) throw new Error("registry exploded");
				// Virtual-model metadata: only `streamSimple` routes it, `complete` would fail on the host.
				return { provider, id: modelId, api: "pi-virtual", name: `${provider}/${modelId}` };
			},
			// Deliberately a landmine: reaching for it means bypassing the virtual-model router.
			complete: () => {
				throw new Error("ModelRegistry.complete must not be used");
			},
			streamSimple: (_model: unknown, _context: unknown, streamOptions: Record<string, unknown>) => {
				recorded.streamOptions.push(streamOptions);
				return { result: respond };
			},
		},
	};

	return { ctx, recorded };
}

function loadExtension(): Map<string, (event: any, ctx: any) => unknown> {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, handler);
			return () => {};
		},
	};
	cyberCompactFallback(pi as never);
	return handlers;
}

function scaffold(config: Record<string, unknown> | null): string {
	const root = mkdtempSync(join(tmpdir(), "cyber-compact-ext-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (config) writeFileSync(join(agentDir, "cyber-compact-fallback.json"), JSON.stringify(config), "utf8");
	return cwd;
}

function beforeCompactEvent(
	reason: string,
	customInstructions?: string,
	fileOps: { read?: Set<string>; written?: Set<string>; edited?: Set<string> } = {},
	signal: AbortSignal = new AbortController().signal,
) {
	return {
		type: "session_before_compact",
		reason,
		customInstructions,
		willRetry: reason === "overflow",
		signal,
		branchEntries: [],
		preparation: {
			messagesToSummarize: [],
			turnPrefixMessages: [],
			previousSummary: undefined,
			firstKeptEntryId: "entry-42",
			tokensBefore: 1234,
			fileOps,
		},
	};
}

function failedEvent(reason: string, errorMessage: string, aborted = false) {
	return { type: "session_compact_failed", reason, errorMessage, aborted, willRetry: false, fromExtension: false };
}

function settleEvent(canContinue = true) {
	return {
		type: "agent_before_settle",
		entries: [],
		continue: false,
		outcome: "error",
		context: { canContinue },
	};
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let pending promise continuations run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function writeConfig(config: Record<string, unknown>): void {
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR as string, "cyber-compact-fallback.json"), JSON.stringify(config), "utf8");
}

/**
 * Capture the extension's timers and Date.now so the `poll → firing macrotask` chain can be
 * stepped deterministically, without real sleeps. `step()` runs the next captured timer.
 */
function captureTimers() {
	const scheduled: Array<() => void> = [];
	const realSetTimeout = globalThis.setTimeout;
	const realDateNow = Date.now;
	let now = 1_000_000;

	Date.now = () => now;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.push(fn);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;

	return {
		pending: () => scheduled.length,
		step: () => scheduled.shift()?.(),
		advance: (ms: number) => {
			now += ms;
		},
		restore: () => {
			globalThis.setTimeout = realSetTimeout;
			Date.now = realDateNow;
		},
	};
}

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("an ordinary compaction is left alone", async () => {
	const cwd = scaffold({ fallbackProvider: "p", fallbackModel: "m" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	const result = await handlers.get("session_before_compact")?.(beforeCompactEvent("threshold"), ctx);

	assert.equal(result, undefined);
	assert.deepEqual(recorded.notifications, []);
});

test("a non-policy failure triggers nothing", async () => {
	const cwd = scaffold({ fallbackProvider: "p", fallbackModel: "m" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", "Compaction failed: terminated"), ctx);
	await settle();

	assert.deepEqual(recorded.notifications, []);
	assert.deepEqual(recorded.compactCalls, []);
});

test("a policy refusal without a configured model only warns", async () => {
	const cwd = scaffold({});
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	assert.equal(recorded.notifications.length, 1);
	assert.match(recorded.notifications[0]?.message ?? "", /未配置回退模型/);
	assert.deepEqual(recorded.compactCalls, []);
});

test("manual retry: waits for idle, then re-triggers compaction and summarises with the fallback model", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { summary: "FALLBACK SUMMARY" });

	await handlers.get("session_before_compact")?.(beforeCompactEvent("manual", "keep db notes"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	assert.match(recorded.notifications[0]?.message ?? "", /重试一次/);
	assert.equal(recorded.compactCalls.length, 1);
	assert.equal(recorded.compactCalls[0]?.customInstructions, "keep db notes");

	// pi re-enters session_before_compact for the compaction we asked for.
	const result = (await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx)) as any;

	assert.equal(result?.compaction?.summary, "FALLBACK SUMMARY");
	assert.equal(result?.compaction?.firstKeptEntryId, "entry-42");
	assert.equal(result?.compaction?.tokensBefore, 1234);
	assert.equal(result?.compaction?.details?.fallback?.model, "test-model");

	handlers.get("session_compact")?.({ type: "session_compact" }, ctx);
	assert.match(recorded.notifications.at(-1)?.message ?? "", /回退压缩完成/);
});

test("manual retry: a second failure is terminal and never retries twice", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	assert.equal(recorded.compactCalls.length, 1);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	assert.equal(recorded.compactCalls.length, 1, "must not queue a third compaction");
	assert.match(recorded.notifications.at(-1)?.message ?? "", /回退压缩也未成功/);
});

test("manual retry: a failing fallback model cancels instead of falling back to the default summarizer", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx } = makeCtx(cwd, { summary: new Error("still refused") });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	const result = (await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx)) as any;
	assert.deepEqual(result, { cancel: true });
});

test("manual retry: an unknown fallback model cancels", async () => {
	const cwd = scaffold({ fallbackProvider: "nope", fallbackModel: "missing" });
	const handlers = loadExtension();
	const { ctx } = makeCtx(cwd);
	ctx.modelRegistry.find = () => undefined;

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	const result = (await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx)) as any;
	assert.deepEqual(result, { cancel: true });
});

test("autoRetry false disables the whole path", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model", autoRetry: false });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	assert.deepEqual(recorded.compactCalls, []);
	assert.deepEqual(recorded.notifications, []);
});

test("a retry that never sees an idle session gives up after the timeout", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model", idleTimeoutMs: 40 });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { idle: false });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle(200);

	assert.deepEqual(recorded.compactCalls, []);
	assert.match(recorded.notifications.at(-1)?.message ?? "", /超时/);
});

test("overflow: the summary is submitted at the settle boundary so the turn continues", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { summary: "OVERFLOW SUMMARY" });

	// pi computes the preparation, tries its own recovery compaction, and gets refused.
	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	assert.match(recorded.notifications.at(-1)?.message ?? "", /本轮结束时/);
	assert.deepEqual(recorded.compactCalls, [], "the boundary path must not call ctx.compact()");

	const result = (await handlers.get("agent_before_settle")?.(
		{ type: "agent_before_settle", entries: [], continue: false, outcome: "error", context: { canContinue: true } },
		ctx,
	)) as any;

	assert.equal(result?.continue, true);
	assert.equal(result?.entries?.length, 1);
	assert.equal(result?.entries?.[0]?.type, "compaction");
	assert.equal(result?.entries?.[0]?.summary, "OVERFLOW SUMMARY");
	assert.equal(result?.entries?.[0]?.firstKeptEntryId, "entry-42");
	assert.match(recorded.notifications.at(-1)?.message ?? "", /继续上一轮/);
});

test("overflow: entries proposed by other extensions are preserved", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx } = makeCtx(cwd);

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	const other = { type: "custom", customType: "other" };
	const result = (await handlers.get("agent_before_settle")?.(
		{ type: "agent_before_settle", entries: [other], continue: false, outcome: "error", context: { canContinue: true } },
		ctx,
	)) as any;

	// `entries` replaces the accumulated array, so anything we drop is lost.
	assert.deepEqual(result?.entries?.[0], other);
	assert.equal(result?.entries?.[1]?.type, "compaction");
});

test("overflow: a context that cannot continue is still repaired", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	const result = (await handlers.get("agent_before_settle")?.({
		type: "agent_before_settle",
		entries: [],
		continue: false,
		outcome: "error",
		context: { canContinue: false },
	}, ctx)) as any;

	// The compaction entry is committed either way; only the auto-resume is dropped.
	assert.equal(result?.continue, false);
	assert.equal(result?.entries?.[0]?.type, "compaction");
	assert.match(recorded.notifications.at(-1)?.message ?? "", /无法自动续跑/);
});

test("overflow: the boundary is only honoured once", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx } = makeCtx(cwd);

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);
	await handlers.get("agent_before_settle")?.(
		{ type: "agent_before_settle", entries: [], continue: false, outcome: "error", context: { canContinue: true } },
		ctx,
	);

	// A later settle boundary in the same session must not re-submit anything.
	const second = await handlers.get("agent_before_settle")?.(
		{ type: "agent_before_settle", entries: [], continue: false, outcome: "completed", context: { canContinue: true } },
		ctx,
	);

	assert.equal(second, undefined);
});

test("the fallback request goes through the provider-neutral streamSimple path", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { summary: "SUMMARY" });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx);

	// `complete` throws, so a successful summary proves it was never called.
	assert.equal(recorded.modelCalls, 1);
	assert.equal(recorded.streamOptions.length, 1);
	assert.ok(!("reasoning" in (recorded.streamOptions[0] ?? {})), "reasoning must stay unset without a thinkingLevel");
});

test("thinkingLevel is passed as reasoning on the fallback request", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model", thinkingLevel: "medium" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { summary: "SUMMARY" });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx);

	assert.equal(recorded.modelCalls, 1);
	assert.equal(recorded.streamOptions[0]?.reasoning, "medium");
});

test("the config is re-read on every use, so edits take effect without a restart", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "first-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx);
	handlers.get("session_compact")?.({ type: "session_compact" }, ctx);

	writeFileSync(join(process.env.PI_CODING_AGENT_DIR as string, "cyber-compact-fallback.json"), JSON.stringify({
		fallbackProvider: "test-provider",
		fallbackModel: "second-model",
	}));

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	const result = (await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx)) as any;

	assert.equal(result?.compaction?.details?.fallback?.model, "second-model");
	assert.ok(recorded.compactCalls.length >= 2);
});

test("the summary records the file lists in the same shape pi uses", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx } = makeCtx(cwd);

	await handlers.get("session_before_compact")?.(
		beforeCompactEvent("overflow", undefined, {
			read: new Set(["a.ts", "b.ts"]),
			written: new Set(["b.ts"]),
			edited: new Set(["c.ts"]),
		}),
		ctx,
	);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	const result = (await handlers.get("agent_before_settle")?.(
		{ type: "agent_before_settle", entries: [], continue: false, outcome: "error", context: { canContinue: true } },
		ctx,
	)) as any;

	// b.ts was written and c.ts edited, so only a.ts counts as read-only.
	assert.deepEqual(result?.entries?.[0]?.details?.readFiles, ["a.ts"]);
	assert.deepEqual(result?.entries?.[0]?.details?.modifiedFiles, ["b.ts", "c.ts"]);
});

test("an unexpected throw in the boundary path still releases the state", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { findThrows: true });

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	// The registry throws: the handler must resolve, not reject.
	const result = await handlers.get("agent_before_settle")?.(
		{ type: "agent_before_settle", entries: [], continue: false, outcome: "error", context: { canContinue: true } },
		ctx,
	);
	assert.equal(result, undefined);

	// And the extension must not be left wedged: a later overflow can arm again.
	const { ctx: healthy } = makeCtx(cwd);
	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), healthy);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), healthy);
	const retry = (await handlers.get("agent_before_settle")?.(
		{ type: "agent_before_settle", entries: [], continue: false, outcome: "error", context: { canContinue: true } },
		healthy,
	)) as any;

	assert.equal(retry?.continue, true, "a stuck state would have made this a no-op");
	assert.ok(recorded.notifications.length > 0);
});

test("an unexpected throw in the retry path cancels instead of falling back to pi's summarizer", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx } = makeCtx(cwd, { findThrows: true });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	const result = await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx);
	assert.deepEqual(result, { cancel: true });
});

test("a successful fallback compaction is not reported twice", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx);
	handlers.get("session_compact")?.({ type: "session_compact" }, ctx);

	const completionNotices = recorded.notifications.filter((n) => n.message.includes("回退压缩完成"));
	assert.equal(completionNotices.length, 1);
});

/**
 * Only a `stop` response is a complete summary. These are the shapes pi-ai can return
 * otherwise; all of them must be refused, even when they carry non-empty text.
 */
const INCOMPLETE_RESPONSES: Array<{ name: string; response: Record<string, unknown>; notice: RegExp }> = [
	{
		name: "error keeps the provider errorMessage",
		response: { content: [{ type: "text", text: "PARTIAL" }], stopReason: "error", errorMessage: "upstream 500" },
		notice: /摘要失败：upstream 500/,
	},
	{
		name: "error without an errorMessage",
		response: { content: [], stopReason: "error" },
		notice: /摘要失败：未知错误/,
	},
	{
		name: "length is a truncated summary",
		response: { content: [{ type: "text", text: "PARTIAL" }], stopReason: "length" },
		notice: /截断/,
	},
	{
		name: "aborted",
		response: { content: [{ type: "text", text: "PARTIAL" }], stopReason: "aborted" },
		notice: /aborted/,
	},
	{
		name: "pending",
		response: { content: [], stopReason: "pending" },
		notice: /pending/,
	},
	{
		name: "toolUse",
		response: { content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse" },
		notice: /toolUse/,
	},
	{
		name: "tool call hidden in a stop response",
		response: {
			content: [{ type: "text", text: "TEXT" }, { type: "toolCall", id: "t1", name: "read", arguments: {} }],
			stopReason: "stop",
		},
		notice: /toolCall/,
	},
	{
		name: "response without a stopReason",
		response: { content: [{ type: "text", text: "TEXT" }] },
		notice: /stopReason=undefined/,
	},
];

interface PathOptions {
	response?: Record<string, unknown>;
	signal?: AbortSignal;
	beforeRespond?: () => void;
}

/** Manual path: refusal → idle → ctx.compact() → our session_before_compact. */
async function runManualRetry(options: PathOptions = {}) {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { response: options.response, beforeRespond: options.beforeRespond });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	const result = await handlers.get("session_before_compact")?.(
		beforeCompactEvent("manual", undefined, {}, options.signal),
		ctx,
	);
	return { result, recorded };
}

/** Overflow path: refusal → the settle boundary produces the summary itself. */
async function runOverflow(options: PathOptions = {}) {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { response: options.response, beforeRespond: options.beforeRespond });
	if (options.signal) ctx.signal = options.signal;

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	const result = await handlers.get("agent_before_settle")?.(settleEvent(), ctx);
	return { result, recorded };
}

test("manual retry: an incomplete fallback response is cancelled, never persisted", async (t) => {
	for (const scenario of INCOMPLETE_RESPONSES) {
		await t.test(scenario.name, async () => {
			const { result, recorded } = await runManualRetry({ response: scenario.response });

			assert.deepEqual(result, { cancel: true });
			assert.equal(recorded.modelCalls, 1);
			assert.match(recorded.notifications.at(-1)?.message ?? "", scenario.notice);
		});
	}
});

test("overflow: an incomplete fallback response is dropped, never written as an entry", async (t) => {
	for (const scenario of INCOMPLETE_RESPONSES) {
		await t.test(scenario.name, async () => {
			const { result, recorded } = await runOverflow({ response: scenario.response });

			assert.equal(result, undefined);
			assert.equal(recorded.modelCalls, 1);
			assert.match(recorded.notifications.at(-1)?.message ?? "", scenario.notice);
		});
	}
});

test("an already-cancelled signal never reaches the fallback model", async (t) => {
	const aborted = new AbortController();
	aborted.abort();

	await t.test("manual retry", async () => {
		const { result, recorded } = await runManualRetry({ signal: aborted.signal });

		assert.deepEqual(result, { cancel: true });
		assert.equal(recorded.modelCalls, 0, "an aborted compaction must not send a request");
		assert.match(recorded.notifications.at(-1)?.message ?? "", /发出前已被取消/);
	});

	await t.test("overflow", async () => {
		const { result, recorded } = await runOverflow({ signal: aborted.signal });

		assert.equal(result, undefined);
		assert.equal(recorded.modelCalls, 0, "an aborted compaction must not send a request");
		assert.match(recorded.notifications.at(-1)?.message ?? "", /发出前已被取消/);
	});
});

test("a response that arrives after cancellation is discarded even when it looks successful", async (t) => {
	await t.test("manual retry", async () => {
		const controller = new AbortController();
		const { result, recorded } = await runManualRetry({
			signal: controller.signal,
			beforeRespond: () => controller.abort(),
		});

		assert.deepEqual(result, { cancel: true });
		assert.equal(recorded.modelCalls, 1);
		assert.match(recorded.notifications.at(-1)?.message ?? "", /丢弃返回的结果/);
	});

	await t.test("overflow", async () => {
		const controller = new AbortController();
		const { result, recorded } = await runOverflow({
			signal: controller.signal,
			beforeRespond: () => controller.abort(),
		});

		assert.equal(result, undefined);
		assert.equal(recorded.modelCalls, 1);
		assert.match(recorded.notifications.at(-1)?.message ?? "", /丢弃返回的结果/);
	});
});

test("a queued retry is superseded by an overflow refusal and never fires late", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { summary: "BOUNDARY SUMMARY" });

	// A threshold compaction is refused: the idle retry is queued.
	const stale = beforeCompactEvent("threshold");
	stale.preparation.firstKeptEntryId = "stale-entry";
	await handlers.get("session_before_compact")?.(stale, ctx);
	handlers.get("session_compact_failed")?.(failedEvent("threshold", CYBER_MESSAGE), ctx);
	assert.match(recorded.notifications.at(-1)?.message ?? "", /空闲后/);

	// Before it can fire, the same run overflows and pi's recovery compaction is refused too.
	const overflow = beforeCompactEvent("overflow");
	overflow.preparation.firstKeptEntryId = "overflow-entry";
	await handlers.get("session_before_compact")?.(overflow, ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);
	assert.match(recorded.notifications.at(-1)?.message ?? "", /本轮结束时/);

	// The queued retry must be gone: no late ctx.compact().
	await settle();
	assert.deepEqual(recorded.compactCalls, []);

	// The boundary uses the overflow attempt's preparation, not the stale threshold one.
	const result = (await handlers.get("agent_before_settle")?.(settleEvent(), ctx)) as any;

	assert.equal(result?.entries?.[0]?.firstKeptEntryId, "overflow-entry");
	assert.equal(result?.entries?.[0]?.summary, "BOUNDARY SUMMARY");
	assert.equal(result?.continue, true);
});

test("agent_settled drops an unconsumed boundary arm so a cancelled run cannot leak it", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	// The run was cancelled (Esc) before agent_before_settle could consume the arm.
	handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

	// The next run's settle boundary must not submit the stale preparation.
	assert.equal(await handlers.get("agent_before_settle")?.(settleEvent(), ctx), undefined);
	assert.equal(recorded.modelCalls, 0);

	// And the extension is not wedged: a fresh overflow can still arm and submit.
	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);
	const retry = (await handlers.get("agent_before_settle")?.(settleEvent(), ctx)) as any;

	assert.equal(retry?.continue, true);
});

test("agent_settled keeps a queued manual retry", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
	await settle();

	assert.equal(recorded.compactCalls.length, 1, "the idle retry must survive agent_settled");
});

test("autoRetry switched off while a retry is queued cancels it", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	writeConfig({ fallbackProvider: "test-provider", fallbackModel: "test-model", autoRetry: false });
	await settle();

	assert.deepEqual(recorded.compactCalls, []);
});

test("autoRetry switched off before the armed compaction cancels instead of using the default summarizer", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	assert.equal(recorded.compactCalls.length, 1);

	writeConfig({ fallbackProvider: "test-provider", fallbackModel: "test-model", autoRetry: false });
	assert.deepEqual(await handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx), { cancel: true });
	assert.equal(recorded.modelCalls, 0, "no fallback request after autoRetry was switched off");

	// The state was released: a new refusal can arm again once autoRetry is back on.
	writeConfig({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();
	assert.equal(recorded.compactCalls.length, 2);
});

test("autoRetry switched off before the boundary submission drops it", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	writeConfig({ fallbackProvider: "test-provider", fallbackModel: "test-model", autoRetry: false });
	assert.equal(await handlers.get("agent_before_settle")?.(settleEvent(), ctx), undefined);
	assert.equal(recorded.modelCalls, 0);

	// Released: switching it back on lets a fresh overflow arm and submit.
	writeConfig({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);
	const result = (await handlers.get("agent_before_settle")?.(settleEvent(), ctx)) as any;

	assert.equal(result?.continue, true);
});

test("the firing macrotask goes back to polling when the session became busy", () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	let busy = false;
	const { ctx, recorded } = makeCtx(cwd, { idle: () => !busy });

	const timers = captureTimers();
	try {
		handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
		assert.equal(timers.pending(), 1, "the idle poll is scheduled");

		timers.step(); // poll: idle → schedules the firing macrotask
		assert.equal(timers.pending(), 1);

		busy = true;
		timers.step(); // macrotask: busy → back to polling instead of interrupting the new run
		assert.deepEqual(recorded.compactCalls, []);
		assert.equal(timers.pending(), 1, "a new poll interval was scheduled");

		busy = false;
		timers.step(); // poll: idle again
		timers.step(); // macrotask: fires
		assert.equal(recorded.compactCalls.length, 1);
	} finally {
		timers.restore();
	}
});

test("the firing macrotask re-checks the deadline and gives up", () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model", idleTimeoutMs: 10 });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	const timers = captureTimers();
	try {
		handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
		timers.step(); // poll: still inside the deadline → schedules the macrotask
		assert.equal(timers.pending(), 1);

		timers.advance(11); // the deadline passes before the macrotask runs
		timers.step();

		assert.deepEqual(recorded.compactCalls, []);
		assert.match(recorded.notifications.at(-1)?.message ?? "", /超时/);
	} finally {
		timers.restore();
	}
});

test("a boundary summary without an upstream signal is abandoned at the deadline and the state released", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model", idleTimeoutMs: 30 });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { respond: () => new Promise(() => {}) });

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	// ctx.signal is undefined in the settle phase, so only the deadline can end this.
	assert.equal(await handlers.get("agent_before_settle")?.(settleEvent(), ctx), undefined);
	assert.equal(recorded.modelCalls, 1);
	assert.match(recorded.notifications.at(-1)?.message ?? "", /超过 30ms 未完成/);

	// The handler released the state: a later overflow can arm and submit again.
	const { ctx: healthy } = makeCtx(cwd, { summary: "SECOND" });
	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), healthy);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), healthy);
	const retry = (await handlers.get("agent_before_settle")?.(settleEvent(), healthy)) as any;

	assert.equal(retry?.continue, true);
	assert.equal(retry?.entries?.[0]?.summary, "SECOND");
});

test("a huge idleTimeoutMs does not turn the fallback request deadline into an instant abort", async () => {
	// Node rewrites a setTimeout delay above 2^31-1 ms to 1 ms; the config caps the value so the
	// request is still allowed to finish asynchronously instead of being aborted immediately.
	const cwd = scaffold({
		fallbackProvider: "test-provider",
		fallbackModel: "test-model",
		idleTimeoutMs: 2_147_483_648,
	});
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, {
		respond: async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return { content: [{ type: "text", text: "SLOW SUMMARY" }], usage: { input: 1, output: 1 }, stopReason: "stop" };
		},
	});

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);

	const result = (await handlers.get("agent_before_settle")?.(settleEvent(), ctx)) as any;

	assert.equal(recorded.modelCalls, 1);
	assert.equal(result?.entries?.[0]?.summary, "SLOW SUMMARY");
});

test("a late success from a call that ignores the signal is discarded, never committed", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model", idleTimeoutMs: 20 });
	const handlers = loadExtension();
	let finish!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		finish = resolve;
	});
	const { ctx, recorded } = makeCtx(cwd, { respond: () => pending });

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);
	assert.equal(await handlers.get("agent_before_settle")?.(settleEvent(), ctx), undefined);

	// The call comes back after the deadline with a complete-looking answer.
	finish({ content: [{ type: "text", text: "LATE SUMMARY" }], usage: { input: 1, output: 1 }, stopReason: "stop" });
	await flush();

	assert.equal(recorded.modelCalls, 1);
	assert.match(recorded.notifications.at(-1)?.message ?? "", /丢弃返回的结果/);
});

test("a late rejection from a call that ignores the signal is handled, never committed", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model", idleTimeoutMs: 20 });
	const handlers = loadExtension();
	let fail!: (error: Error) => void;
	const pending = new Promise((_, reject) => {
		fail = reject;
	});
	const { ctx, recorded } = makeCtx(cwd, { respond: () => pending });

	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);
	assert.equal(await handlers.get("agent_before_settle")?.(settleEvent(), ctx), undefined);

	fail(new Error("late boom"));
	await flush();

	assert.match(recorded.notifications.at(-1)?.message ?? "", /摘要失败：late boom/);
});

test("the upstream compaction signal cancels a summary that is still in flight", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { respond: () => new Promise(() => {}) });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	const controller = new AbortController();
	const request = handlers.get("session_before_compact")?.(
		beforeCompactEvent("manual", undefined, {}, controller.signal),
		ctx,
	);
	assert.equal(recorded.modelCalls, 1, "the request was issued");

	controller.abort();
	assert.deepEqual(await request, { cancel: true });
});

test("session_shutdown aborts an in-flight summary", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd, { respond: () => new Promise(() => {}) });

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	await settle();

	const request = handlers.get("session_before_compact")?.(beforeCompactEvent("manual"), ctx);
	assert.equal(recorded.modelCalls, 1);

	handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
	handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

	assert.deepEqual(await request, { cancel: true });
});

test("session_shutdown clears a queued retry timer and an unconsumed boundary arm", async () => {
	const cwd = scaffold({ fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const handlers = loadExtension();
	const { ctx, recorded } = makeCtx(cwd);

	handlers.get("session_compact_failed")?.(failedEvent("manual", CYBER_MESSAGE), ctx);
	handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
	handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
	await settle();

	assert.deepEqual(recorded.compactCalls, [], "the queued retry must not fire after shutdown");

	// A boundary arm and its preparation are dropped too.
	await handlers.get("session_before_compact")?.(beforeCompactEvent("overflow"), ctx);
	handlers.get("session_compact_failed")?.(failedEvent("overflow", CYBER_MESSAGE), ctx);
	handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

	assert.equal(await handlers.get("agent_before_settle")?.(settleEvent(), ctx), undefined);
	assert.equal(recorded.modelCalls, 0);
});
