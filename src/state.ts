/**
 * The retry state machine.
 *
 * No pi imports: this is pure logic so it can be unit-tested exhaustively.
 *
 * Phases
 *   idle                     nothing to do
 *   retry-scheduled          a policy refusal was seen (manual/threshold) and we are waiting for idle
 *   fallback-armed           ctx.compact() was called; the next session_before_compact is ours
 *   fallback-running         our handler is producing the summary for that compaction
 *   fallback-armed-boundary  a policy refusal was seen during overflow recovery; waiting for agent_before_settle
 *   boundary-running         our agent_before_settle handler is producing the summary
 */

import type { CompactReason } from "./types.ts";

export type Phase =
	| "idle"
	| "retry-scheduled"
	| "fallback-armed"
	| "fallback-running"
	| "fallback-armed-boundary"
	| "boundary-running";

export interface CompactFailedOptions {
	/** The failure message matched a configured policy pattern. */
	policyRefusal: boolean;
	/** `autoRetry` from config. */
	autoRetry: boolean;
	/** `fallbackProvider` and `fallbackModel` are both set. */
	modelConfigured: boolean;
}

export type CompactFailedDecision =
	/** Not ours, or nothing to do. */
	| { kind: "ignore" }
	/** A policy refusal, but no usable fallback model is configured. */
	| { kind: "missing-config" }
	/** Our own fallback attempt failed; stop and report. */
	| { kind: "fallback-failed" }
	/** Overflow: arm the settle boundary so the aborted turn can continue. */
	| { kind: "arm-boundary" }
	/** Manual/threshold: schedule a delayed ctx.compact() retry. */
	| { kind: "arm-retry" };

export type BeforeCompactDecision = { kind: "pass-through" } | { kind: "fallback" };

export type BeforeSettleDecision =
	| { kind: "ignore" }
	| { kind: "expired" }
	/** Submit the compaction; `continueRun` mirrors pi's own `canContinue` gate. */
	| { kind: "submit"; continueRun: boolean };

export class FallbackState {
	private phase: Phase = "idle";
	private armedAt = 0;

	/** Kept so a retry can reuse the instructions from the original `/compact ...`. */
	lastCustomInstructions: string | undefined;
	/** Why the compaction that we are recovering from was triggered. */
	lastReason: CompactReason | undefined;

	get current(): Phase {
		return this.phase;
	}

	reset(): void {
		this.phase = "idle";
		this.armedAt = 0;
	}

	/** Called for every compaction, including the ones we do not touch. */
	onBeforeCompact(reason: CompactReason, customInstructions: string | undefined): BeforeCompactDecision {
		this.lastCustomInstructions = customInstructions;
		this.lastReason = reason;

		if (this.phase === "fallback-armed") {
			this.phase = "fallback-running";
			return { kind: "fallback" };
		}

		return { kind: "pass-through" };
	}

	onCompactFailed(reason: CompactReason, options: CompactFailedOptions): CompactFailedDecision {
		// Phases where we already issued a compaction of our own: this failure is its outcome.
		if (this.phase === "fallback-armed" || this.phase === "fallback-running") {
			this.reset();
			return { kind: "fallback-failed" };
		}

		// An overflow refusal supersedes a retry that is still waiting for idle: the boundary path
		// can keep the interrupted turn alive, and it uses the preparation of this same overflow
		// attempt. Duplicates and non-policy failures must leave the queued retry alone.
		if (
			this.phase === "retry-scheduled" &&
			reason === "overflow" &&
			options.autoRetry &&
			options.policyRefusal &&
			options.modelConfigured
		) {
			this.phase = "fallback-armed-boundary";
			this.armedAt = Date.now();
			return { kind: "arm-boundary" };
		}

		// Already handling something (or waiting on the settle boundary): never arm twice.
		if (this.phase !== "idle") return { kind: "ignore" };

		if (!options.autoRetry) return { kind: "ignore" };
		if (!options.policyRefusal) return { kind: "ignore" };
		if (!options.modelConfigured) return { kind: "missing-config" };

		if (reason === "overflow") {
			this.phase = "fallback-armed-boundary";
			this.armedAt = Date.now();
			return { kind: "arm-boundary" };
		}

		this.phase = "retry-scheduled";
		return { kind: "arm-retry" };
	}

	/** The idle poll decided to fire `ctx.compact()`. Returns false if the arm was cleared meanwhile. */
	onRetryFired(): boolean {
		if (this.phase !== "retry-scheduled") return false;
		this.phase = "fallback-armed";
		return true;
	}

	/** A retry that never got to run (timeout, session shutdown). */
	cancelRetry(): boolean {
		if (this.phase !== "retry-scheduled") return false;
		this.reset();
		return true;
	}

	onBeforeSettle(canContinue: boolean, ttlMs: number): BeforeSettleDecision {
		if (this.phase !== "fallback-armed-boundary") return { kind: "ignore" };

		if (Date.now() - this.armedAt > ttlMs) {
			this.reset();
			return { kind: "expired" };
		}

		this.phase = "boundary-running";
		// Submitting the summary is worth doing even when the run cannot continue: it repairs the
		// context, so the next turn does not overflow again. Only the auto-resume is skipped.
		return { kind: "submit", continueRun: canContinue };
	}

	/** Returns true when the successful compaction was the one we produced. */
	onCompactSucceeded(): boolean {
		const ours = this.phase === "fallback-running";
		this.reset();
		return ours;
	}
}
