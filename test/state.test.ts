import assert from "node:assert/strict";
import { test } from "node:test";

import { FallbackState } from "../src/state.ts";

const READY = { policyRefusal: true, autoRetry: true, modelConfigured: true };
const TTL = 120_000;

test("a policy refusal on a manual compaction schedules a retry", () => {
	const state = new FallbackState();
	assert.equal(state.onBeforeCompact("manual", undefined).kind, "pass-through");
	assert.equal(state.onCompactFailed("manual", READY).kind, "arm-retry");
	assert.equal(state.current, "retry-scheduled");
});

test("the retry path ends in a fallback compaction", () => {
	const state = new FallbackState();
	state.onCompactFailed("threshold", READY);

	assert.equal(state.onRetryFired(), true);
	assert.equal(state.current, "fallback-armed");

	// The compaction we triggered comes back through session_before_compact.
	assert.equal(state.onBeforeCompact("manual", "keep db notes").kind, "fallback");
	assert.equal(state.current, "fallback-running");

	assert.equal(state.onCompactSucceeded(), true);
	assert.equal(state.current, "idle");
});

test("the retry reuses the instructions of the original /compact", () => {
	const state = new FallbackState();
	state.onBeforeCompact("manual", "focus on the migration");
	state.onCompactFailed("manual", READY);
	assert.equal(state.lastCustomInstructions, "focus on the migration");
});

test("a fallback attempt that fails again is terminal", () => {
	const state = new FallbackState();
	state.onCompactFailed("manual", READY);
	state.onRetryFired();
	state.onBeforeCompact("manual", undefined);

	assert.equal(state.onCompactFailed("manual", READY).kind, "fallback-failed");
	assert.equal(state.current, "idle");
});

test("a duplicate failure while the retry is still queued is ignored", () => {
	const state = new FallbackState();
	state.onCompactFailed("threshold", READY);
	// e.g. another manual/threshold failure before we ever got to retry
	assert.equal(state.onCompactFailed("manual", READY).kind, "ignore");
	assert.equal(state.onCompactFailed("threshold", READY).kind, "ignore");
	assert.equal(state.current, "retry-scheduled");
});

test("an overflow refusal upgrades a queued retry to the settle boundary", () => {
	const state = new FallbackState();
	state.onCompactFailed("threshold", READY);

	// The running turn overflowed: the boundary path can keep it alive, and it uses the
	// preparation of that overflow attempt, so it supersedes the idle retry.
	assert.equal(state.onCompactFailed("overflow", READY).kind, "arm-boundary");
	assert.equal(state.current, "fallback-armed-boundary");

	// The superseded retry must not fire a late ctx.compact().
	assert.equal(state.onRetryFired(), false);
	assert.deepEqual(state.onBeforeSettle(true, TTL), { kind: "submit", continueRun: true });
});

test("a queued retry is only upgraded by a usable overflow refusal", () => {
	const state = new FallbackState();
	state.onCompactFailed("threshold", READY);

	// A non-policy, disabled, or unconfigured overflow refusal must not replace the queued retry.
	assert.equal(state.onCompactFailed("overflow", { ...READY, policyRefusal: false }).kind, "ignore");
	assert.equal(state.onCompactFailed("overflow", { ...READY, autoRetry: false }).kind, "ignore");
	assert.equal(state.onCompactFailed("overflow", { ...READY, modelConfigured: false }).kind, "ignore");
	assert.equal(state.current, "retry-scheduled");

	// And the retry is still there to fire.
	assert.equal(state.onRetryFired(), true);
});

test("only one retry per failure, and no stickiness afterwards", () => {
	const state = new FallbackState();
	state.onCompactFailed("manual", READY);
	state.onRetryFired();
	state.onBeforeCompact("manual", undefined);
	state.onCompactSucceeded();

	// The next compaction must go back to pi's default model.
	assert.equal(state.onBeforeCompact("manual", undefined).kind, "pass-through");
});

test("a non-policy failure is ignored", () => {
	const state = new FallbackState();
	assert.equal(state.onCompactFailed("manual", { ...READY, policyRefusal: false }).kind, "ignore");
	assert.equal(state.current, "idle");
});

test("autoRetry false disables the retry", () => {
	const state = new FallbackState();
	assert.equal(state.onCompactFailed("manual", { ...READY, autoRetry: false }).kind, "ignore");
	assert.equal(state.current, "idle");
});

test("a policy refusal without a configured model is reported, not retried", () => {
	const state = new FallbackState();
	assert.equal(state.onCompactFailed("manual", { ...READY, modelConfigured: false }).kind, "missing-config");
	assert.equal(state.current, "idle");
});

test("overflow arms the settle boundary instead of a ctx.compact retry", () => {
	const state = new FallbackState();
	assert.equal(state.onCompactFailed("overflow", READY).kind, "arm-boundary");
	assert.equal(state.current, "fallback-armed-boundary");

	// The armed boundary must not hijack the next ordinary compaction.
	assert.equal(state.onBeforeCompact("threshold", undefined).kind, "pass-through");
	assert.equal(state.current, "fallback-armed-boundary");

	const decision = state.onBeforeSettle(true, TTL);
	assert.deepEqual(decision, { kind: "submit", continueRun: true });
	assert.equal(state.current, "boundary-running");

	// The boundary path emits no session_compact, so the handler resets explicitly.
	state.reset();
	assert.equal(state.current, "idle");
});

test("the summary is still submitted when the run cannot continue", () => {
	const state = new FallbackState();
	state.onCompactFailed("overflow", READY);
	// pi reports canContinue=false: the context still needs repairing, only the auto-resume is
	// skipped, otherwise the next turn overflows again.
	assert.deepEqual(state.onBeforeSettle(false, TTL), { kind: "submit", continueRun: false });
	assert.equal(state.current, "boundary-running");
	state.reset();
	assert.equal(state.current, "idle");
});

test("the boundary expires so it cannot fire in a much later run", () => {
	const state = new FallbackState();
	state.onCompactFailed("overflow", READY);
	assert.equal(state.onBeforeSettle(true, -1).kind, "expired");
	assert.equal(state.current, "idle");
});

test("a settle boundary without an armed state is ignored", () => {
	const state = new FallbackState();
	assert.equal(state.onBeforeSettle(true, TTL).kind, "ignore");
});

test("a compaction failure during the boundary path does not re-arm", () => {
	const state = new FallbackState();
	state.onCompactFailed("overflow", READY);
	// Something else fails while we wait for settle: keep the arm, never arm twice.
	assert.equal(state.onCompactFailed("overflow", READY).kind, "ignore");
	assert.equal(state.current, "fallback-armed-boundary");
});

test("cancelling a queued retry clears it", () => {
	const state = new FallbackState();
	state.onCompactFailed("manual", READY);
	assert.equal(state.cancelRetry(), true);
	assert.equal(state.current, "idle");
	// and a late timer that still fires must not resurrect the retry
	assert.equal(state.onRetryFired(), false);
});

test("cancelling is a no-op outside the queued phase", () => {
	const state = new FallbackState();
	assert.equal(state.cancelRetry(), false);
});

test("an unsuccessful compaction that is not ours clears a stale running state", () => {
	const state = new FallbackState();
	state.onCompactFailed("manual", READY);
	state.onRetryFired();
	assert.equal(state.current, "fallback-armed");
	// ctx.compact() aborted before it ever reached session_before_compact
	assert.equal(state.onCompactFailed("manual", READY).kind, "fallback-failed");
	assert.equal(state.current, "idle");
});
