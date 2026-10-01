import assert from "node:assert/strict";
import { test } from "node:test";

import { compilePatterns, isPolicyRefusal } from "../src/detector.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const defaultPatterns = compilePatterns(DEFAULT_CONFIG.patterns, DEFAULT_CONFIG.caseInsensitive).compiled;

// The message shape this extension was built for: pi wraps the provider error and the
// gateway in front of the provider surfaces the upstream reason in the message text.
const CYBER_MESSAGE =
	"Compaction failed: bad response status code 400, upstream code: cyber_policy, type: invalid_request_error";

test("matches a cyber policy refusal", () => {
	assert.equal(isPolicyRefusal({ errorMessage: CYBER_MESSAGE, aborted: false }, defaultPatterns), true);
});

test("matches the other default policy phrasings", () => {
	const cases = [
		"Auto-compaction failed: content_policy violation",
		"Auto-compaction failed: content-filter triggered",
		"Auto-compaction failed: content policy violation",
		"Context overflow recovery failed: policy_violation",
		"Context overflow recovery failed: policy violation",
		"Compaction failed: safety_block",
		"Compaction failed: safety refusal",
		"Compaction failed: This request was blocked by a safety filter",
	];
	for (const message of cases) {
		assert.equal(isPolicyRefusal({ errorMessage: message, aborted: false }, defaultPatterns), true, message);
	}
});

test("matching is case insensitive by default", () => {
	assert.equal(isPolicyRefusal({ errorMessage: "Upstream code: CYBER_POLICY", aborted: false }, defaultPatterns), true);
});

// pi-ai's Anthropic adapter maps the `refusal` and `sensitive` stop reasons to these two
// messages, and pi wraps the thrown error with one of three prefixes depending on why it compacted.
test("matches pi's Anthropic refusal and sensitive stop messages", () => {
	const cases = [
		"The model refused to complete the request",
		"Compaction failed: The model refused to complete the request",
		"Auto-compaction failed: The model refused to complete the request",
		"Context overflow recovery failed: The model refused to complete the request",
		"Provider stopped with: sensitive",
		"Compaction failed: Provider stopped with: sensitive",
		"Auto-compaction failed: Provider stopped with: sensitive",
		"Context overflow recovery failed: Provider stopped with: sensitive",
	];
	for (const message of cases) {
		assert.equal(isPolicyRefusal({ errorMessage: message, aborted: false }, defaultPatterns), true, message);
	}
});

test("the pi safety messages match whatever the case", () => {
	const cases = [
		"Compaction failed: THE MODEL REFUSED TO COMPLETE THE REQUEST",
		"Compaction failed: the model Refused to complete the request",
		"Compaction failed: PROVIDER STOPPED WITH: SENSITIVE",
		"Compaction failed: Provider Stopped With: Sensitive",
	];
	for (const message of cases) {
		assert.equal(isPolicyRefusal({ errorMessage: message, aborted: false }, defaultPatterns), true, message);
	}
});

test("does not match transport, auth or context-limit failures", () => {
	const cases = [
		"Compaction failed: terminated",
		"Compaction failed: socket closed",
		"Compaction failed: ETIMEDOUT",
		"Compaction failed: ECONNRESET",
		"Compaction failed: 401 invalid api key",
		"Compaction failed: unauthorized",
		"Compaction failed: context_length_exceeded",
		"Compaction failed: maximum context length is 200000 tokens",
		"Compaction failed: bad response status code 400",
		"Compaction failed: 500 internal server error",
	];
	for (const message of cases) {
		assert.equal(isPolicyRefusal({ errorMessage: message, aborted: false }, defaultPatterns), false, message);
	}
});

// The new patterns must stay precise: bare `refus`/`sensitive` vocabulary shows up in
// transport, data and configuration errors that have nothing to do with a policy refusal.
test("does not match non-policy errors that merely contain refused or sensitive", () => {
	const cases = [
		"Compaction failed: connection refused",
		"Compaction failed: connect ECONNREFUSED 127.0.0.1:443",
		"Compaction failed: upstream refused the connection",
		"Compaction failed: sensitive file access denied",
		"Compaction failed: failed to redact sensitive data",
		"Compaction failed: Provider stopped with: overloaded",
		"Compaction failed: sensitive",
		"Compaction failed: refusal",
	];
	for (const message of cases) {
		assert.equal(isPolicyRefusal({ errorMessage: message, aborted: false }, defaultPatterns), false, message);
	}
});

test("ignores cancellations even when the message looks like a refusal", () => {
	assert.equal(isPolicyRefusal({ errorMessage: CYBER_MESSAGE, aborted: true }, defaultPatterns), false);
});

test("ignores failures without a message", () => {
	assert.equal(isPolicyRefusal({ aborted: false }, defaultPatterns), false);
	assert.equal(isPolicyRefusal({ errorMessage: "", aborted: false }, defaultPatterns), false);
});

test("user supplied patterns replace the defaults", () => {
	const custom = compilePatterns(["my_gateway_refusal"], true).compiled;
	assert.equal(isPolicyRefusal({ errorMessage: CYBER_MESSAGE, aborted: false }, custom), false);
	assert.equal(isPolicyRefusal({ errorMessage: "Compaction failed: my_gateway_refusal", aborted: false }, custom), true);
	// The built-in patterns, including the Anthropic safety messages, are gone once replaced.
	assert.equal(
		isPolicyRefusal({ errorMessage: "Compaction failed: The model refused to complete the request", aborted: false }, custom),
		false,
	);
});

test("case sensitivity can be turned off", () => {
	const sensitive = compilePatterns(["CYBER_POLICY"], false).compiled;
	assert.equal(isPolicyRefusal({ errorMessage: "upstream code: cyber_policy", aborted: false }, sensitive), false);
	assert.equal(isPolicyRefusal({ errorMessage: "upstream code: CYBER_POLICY", aborted: false }, sensitive), true);
});

test("an invalid regex is reported and skipped without losing the others", () => {
	const { compiled, invalid } = compilePatterns(["cyber_policy", "([unclosed"], true);
	assert.deepEqual(invalid, ["([unclosed"]);
	assert.equal(compiled.length, 1);
	assert.equal(isPolicyRefusal({ errorMessage: CYBER_MESSAGE, aborted: false }, compiled), true);
});

test("a pattern is not stateful across calls", () => {
	// Guards against ever compiling with the `g` flag: a global regex keeps lastIndex
	// between calls and would start alternating true/false.
	const repeated = compilePatterns(["cyber_policy"], true).compiled;
	for (let i = 0; i < 5; i += 1) {
		assert.equal(isPolicyRefusal({ errorMessage: CYBER_MESSAGE, aborted: false }, repeated), true, `call ${i}`);
	}
});
