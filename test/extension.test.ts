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
}

function makeCtx(
	cwd: string,
	options: { idle?: boolean; summary?: string | Error; findThrows?: boolean } = {},
): { ctx: any; recorded: Recorded } {
	const recorded: Recorded = { notifications: [], compactCalls: [] };
	const summary = options.summary ?? "SUMMARY";

	const ctx = {
		cwd,
		signal: undefined,
		isIdle: () => options.idle ?? true,
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
				return { provider, id: modelId };
			},
			complete: async () => {
				if (summary instanceof Error) throw summary;
				return { content: [{ type: "text", text: summary }], usage: { input: 1, output: 1 } };
			},
			streamSimple: () => ({
				result: async () => {
					if (summary instanceof Error) throw summary;
					return { content: [{ type: "text", text: summary }], usage: { input: 1, output: 1 } };
				},
			}),
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
) {
	return {
		type: "session_before_compact",
		reason,
		customInstructions,
		willRetry: reason === "overflow",
		signal: new AbortController().signal,
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

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

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
