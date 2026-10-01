/**
 * Shared types for pi-cyber-compact-fallback.
 *
 * Nothing in this module imports pi: it stays a plain, unit-testable description
 * of the on-disk configuration.
 */

/** Why pi decided to compact. Mirrors the `reason` field of pi's compaction events. */
export type CompactReason = "manual" | "threshold" | "overflow";

/** Thinking levels accepted by pi-ai (`SimpleStreamOptions.reasoning`). */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface FallbackConfig {
	/** Provider id of the fallback model, e.g. `"your-provider"`. Required for a retry to happen. */
	fallbackProvider?: string;
	/** Model id of the fallback model, e.g. `"your-model"`. Required for a retry to happen. */
	fallbackModel?: string;
	/** Master switch. When false the extension never retries. */
	autoRetry: boolean;
	/** Regex sources matched against the compaction failure message. */
	patterns: string[];
	/** Compile `patterns` with the `i` flag. */
	caseInsensitive: boolean;
	/** Optional thinking level for the fallback request. Omitted means "provider default". */
	thinkingLevel?: ThinkingLevel;
	/** Output cap for the summary request. */
	maxSummaryTokens: number;
	/** Safety cap on the serialized conversation handed to the fallback model. */
	maxConversationChars: number;
	/**
	 * How long to wait for the session to go idle before giving up (also bounds how long a boundary
	 * retry stays armed), and the deadline for each fallback summary request: a request still running
	 * when it passes is abandoned, so a call that ignores its AbortSignal cannot stall the run.
	 */
	idleTimeoutMs: number;
	/** Replaces the built-in summary prompt. Supports `{conversation}`, `{previousSummary}`, `{customInstructions}`. */
	promptTemplate: string | null;
}

export const DEFAULT_CONFIG: FallbackConfig = {
	autoRetry: true,
	patterns: [
		"cyber_policy",
		// Upstream codes tend to use underscores, but prose in error messages uses spaces.
		"content[\\s_-]?policy",
		"content[\\s_-]?filter",
		"policy[\\s_-]?violation",
		"safety[\\s_-]?(block|refus|filter)",
		// pi-ai's Anthropic adapter maps `refusal` / `sensitive` stop reasons to these exact
		// messages. Kept precise on purpose: bare `refus`/`sensitive` also appear in transport
		// ("connection refused") and data ("sensitive file") errors, which must not retry.
		"model\\s+refused",
		"provider\\s+stopped with:\\s*sensitive",
	],
	caseInsensitive: true,
	maxSummaryTokens: 8192,
	maxConversationChars: 400_000,
	idleTimeoutMs: 120_000,
	promptTemplate: null,
};

export const CONFIG_FILENAME = "cyber-compact-fallback.json";
