/**
 * pi-cyber-compact-fallback
 *
 * When pi's compaction summary is rejected by an upstream content policy, retry the
 * compaction once with a model the user configures, so the session is not stuck.
 *
 * Two paths, because the two failure shapes need different recovery:
 *
 *   manual / threshold   pi keeps running after the failure, so we wait for the session
 *                        to go idle and then trigger a fresh compaction with ctx.compact().
 *                        The next session_before_compact sees our armed state and produces
 *                        the summary itself.
 *
 *   overflow             pi had already aborted a turn and intended to retry it once the
 *                        context was repaired. We reproduce that by submitting the summary
 *                        as a compaction entry at the agent_before_settle boundary with
 *                        `continue: true`, which makes pi run that turn in the same loop.
 *                        Nothing here calls ctx.compact(): the boundary runs inside the
 *                        existing run, which is why this path has no re-entrancy hazard.
 */

import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	CompactOptions,
	CompactionEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../src/config.ts";
import { compilePatterns, isPolicyRefusal } from "../src/detector.ts";
import { FallbackState } from "../src/state.ts";
import { type SummarizeDeps, type SummarizeInput, computeFileLists, summarize } from "../src/summarize.ts";
import type { FallbackConfig } from "../src/types.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];
type NotifyLevel = "info" | "warning" | "error";

const IDLE_POLL_INTERVAL_MS = 250;

export default function cyberCompactFallback(pi: ExtensionAPI): void {
	const state = new FallbackState();
	const warned = new Set<string>();
	let preparation: Preparation | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const notify = (ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void => {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// Modes without a UI (print/json) must not break the retry.
		}
	};

	const warnOnce = (ctx: ExtensionContext, message: string): void => {
		if (warned.has(message)) return;
		warned.add(message);
		notify(ctx, `[cyber-compact-fallback] ${message}`, "warning");
	};

	/** Re-read from disk every time: editing the file must take effect immediately. */
	const load = (ctx: ExtensionContext): FallbackConfig => {
		const { config, warnings } = loadConfig(ctx.cwd);
		for (const warning of warnings) warnOnce(ctx, warning);
		return config;
	};

	const clearTimer = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const modelLabel = (config: FallbackConfig): string => `${config.fallbackProvider}/${config.fallbackModel}`;

	const detailsFor = (
		config: FallbackConfig,
		trigger: string,
		originalReason: string | undefined,
		fileOps: Preparation["fileOps"] | undefined,
	) => {
		// Same shape as pi's own CompactionDetails, so downstream tooling can read it.
		const { readFiles, modifiedFiles } = computeFileLists(fileOps ?? {});
		return {
			readFiles,
			modifiedFiles,
			fallback: {
				extension: "pi-cyber-compact-fallback",
				provider: config.fallbackProvider,
				model: config.fallbackModel,
				trigger,
				originalReason,
			},
		};
	};

	/**
	 * pi's registry methods are generic over the provider api, so the extension treats the
	 * registry structurally instead of threading those generics through.
	 */
	const runSummary = (
		input: SummarizeInput,
		ctx: ExtensionContext,
		config: FallbackConfig,
		signal: AbortSignal | undefined,
	): ReturnType<typeof summarize> =>
		summarize(input, config, {
			modelRegistry: ctx.modelRegistry as unknown as SummarizeDeps["modelRegistry"],
			notify: (message, level) => notify(ctx, message, level),
			signal,
		});

	const scheduleRetry = (ctx: ExtensionContext, config: FallbackConfig): void => {
		const deadline = Date.now() + config.idleTimeoutMs;

		const poll = (): void => {
			if (state.current !== "retry-scheduled") return;

			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				state.cancelRetry();
				notify(ctx, "等待会话空闲超时，已放弃自动重试；可手动执行 /compact", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				// Never sleep past the deadline, otherwise a short idleTimeoutMs is silently ignored.
				timer = setTimeout(poll, Math.min(IDLE_POLL_INTERVAL_MS, remaining));
				return;
			}

			// One extra macrotask so the failed compaction has fully unwound: its `finally`
			// clears the abort controller unconditionally, and starting a new compaction
			// before that would have the controller cleared out from under it.
			timer = setTimeout(() => {
				if (!state.onRetryFired()) return;

				// No onError notification: pi both invokes it and emits session_compact_failed for the
				// same failure, which would report it twice.
				const options: CompactOptions = { customInstructions: state.lastCustomInstructions };
				ctx.compact(options);
			}, 0);
		};

		timer = setTimeout(poll, 0);
	};

	pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
		const decision = state.onBeforeCompact(event.reason, event.customInstructions);
		// Always stash: the overflow boundary path needs the preparation pi computed.
		preparation = event.preparation;

		if (decision.kind !== "fallback") return undefined;

		// A throw here would make pi fall through to its default summarizer, sending the same
		// conversation to the same refusing upstream again. Cancel instead, always.
		try {
			const config = load(ctx);
			const outcome = await runSummary(
				{
					messagesToSummarize: event.preparation.messagesToSummarize,
					turnPrefixMessages: event.preparation.turnPrefixMessages,
					previousSummary: event.preparation.previousSummary,
					customInstructions: event.customInstructions,
				},
				ctx,
				config,
				event.signal,
			);

			if (!outcome) return { cancel: true };

			return {
				compaction: {
					summary: outcome.summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: outcome.usage as CompactionEntryDraft["usage"],
					details: detailsFor(config, "policy-refusal", state.lastReason, event.preparation.fileOps),
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `回退压缩出现未预期错误，已取消本次压缩：${message}`, "error");
			return { cancel: true };
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		if (state.onCompactSucceeded()) notify(ctx, "回退压缩完成", "info");
	});

	pi.on("session_compact_failed", (event: SessionCompactFailedEvent, ctx) => {
		const config = load(ctx);
		const { compiled, invalid } = compilePatterns(config.patterns, config.caseInsensitive);
		for (const source of invalid) warnOnce(ctx, `patterns 中的正则无效，已跳过：${source}`);

		const decision = state.onCompactFailed(event.reason, {
			policyRefusal: isPolicyRefusal(event, compiled),
			autoRetry: config.autoRetry,
			modelConfigured: Boolean(config.fallbackProvider && config.fallbackModel),
		});

		switch (decision.kind) {
			case "ignore":
				return;
			case "missing-config":
				notify(
					ctx,
					"检测到内容策略拒绝，但未配置回退模型（cyber-compact-fallback.json 的 fallbackProvider / fallbackModel）",
					"warning",
				);
				return;
			case "fallback-failed":
				notify(ctx, `回退压缩也未成功（${event.errorMessage ?? "已取消"}），已放弃自动重试`, "error");
				return;
			case "arm-boundary":
				notify(ctx, `压缩被内容策略拒绝，将在本轮结束时用 ${modelLabel(config)} 重压并继续…`, "info");
				return;
			case "arm-retry":
				notify(ctx, `压缩被内容策略拒绝，将在空闲后用 ${modelLabel(config)} 重试一次…`, "info");
				scheduleRetry(ctx, config);
				return;
		}
	});

	pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx): Promise<BoundaryResult | undefined> => {
		const config = load(ctx);
		const decision = state.onBeforeSettle(event.context.canContinue, config.idleTimeoutMs);

		if (decision.kind === "ignore") return undefined;

		if (decision.kind === "expired") {
			notify(ctx, "回退压缩布防超时，已放弃；可手动执行 /compact", "warning");
			return undefined;
		}

		const continueRun = decision.continueRun;

		const stashed = preparation;
		if (!stashed) {
			state.reset();
			notify(ctx, "回退压缩缺少暂存的 preparation，已放弃", "warning");
			return undefined;
		}

		// The boundary path emits no session_compact, so nothing else can release the state. If
		// anything below throws, the extension would stay armed for the rest of the session and
		// silently stop working, so the finally always releases it.
		try {
			const outcome = await runSummary(
				{
					messagesToSummarize: stashed.messagesToSummarize,
					turnPrefixMessages: stashed.turnPrefixMessages,
					previousSummary: stashed.previousSummary,
				},
				ctx,
				config,
				ctx.signal,
			);

			if (!outcome) return undefined;

			const draft: CompactionEntryDraft = {
				type: "compaction",
				summary: outcome.summary,
				firstKeptEntryId: stashed.firstKeptEntryId,
				details: detailsFor(config, "policy-refusal-overflow", "overflow", stashed.fileOps),
				usage: outcome.usage as CompactionEntryDraft["usage"],
			};

			notify(
				ctx,
				continueRun
					? `已用 ${modelLabel(config)} 完成压缩，继续上一轮…`
					: `已用 ${modelLabel(config)} 完成压缩；本轮无法自动续跑，请重发上一条消息`,
				continueRun ? "info" : "warning",
			);

			// `entries` replaces the accumulated list, so carry the other handlers' drafts forward.
			return { entries: [...event.entries, draft], continue: continueRun };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `回退压缩出现未预期错误，已放弃：${message}`, "error");
			return undefined;
		} finally {
			if (state.current === "boundary-running") state.reset();
		}
	});
	pi.on("session_shutdown", () => {
		clearTimer();
		state.reset();
	});
}
