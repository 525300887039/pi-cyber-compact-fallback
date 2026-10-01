import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { MAX_TIMER_DELAY_MS, loadConfig, resolveAgentDir, resolveConfigPaths } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const roots: string[] = [];

function scaffold(): { agentDir: string; projectDir: string; cwd: string; env: NodeJS.ProcessEnv } {
	const root = mkdtempSync(join(tmpdir(), "cyber-compact-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	return { agentDir, projectDir, cwd: projectDir, env: { PI_CODING_AGENT_DIR: agentDir } };
}

function writeGlobal(agentDir: string, value: unknown): void {
	writeFileSync(join(agentDir, "cyber-compact-fallback.json"), JSON.stringify(value), "utf8");
}

function writeProject(cwd: string, value: unknown | string): void {
	const body = typeof value === "string" ? value : JSON.stringify(value);
	writeFileSync(join(cwd, ".pi", "cyber-compact-fallback.json"), body, "utf8");
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("falls back to defaults when no config file exists", () => {
	const { cwd, env } = scaffold();
	const { config, warnings } = loadConfig(cwd, env);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);
});

test("global config is applied", () => {
	const { agentDir, cwd, env } = scaffold();
	writeGlobal(agentDir, { fallbackProvider: "test-provider", fallbackModel: "test-model" });
	const { config } = loadConfig(cwd, env);
	assert.equal(config.fallbackProvider, "test-provider");
	assert.equal(config.fallbackModel, "test-model");
	// untouched keys keep their defaults
	assert.equal(config.maxSummaryTokens, DEFAULT_CONFIG.maxSummaryTokens);
});

test("project config overrides the global one key by key", () => {
	const { agentDir, cwd, env } = scaffold();
	writeGlobal(agentDir, { fallbackProvider: "test-provider", fallbackModel: "test-model", maxSummaryTokens: 4096 });
	writeProject(cwd, { fallbackModel: "other-model" });
	const { config } = loadConfig(cwd, env);
	assert.equal(config.fallbackProvider, "test-provider");
	assert.equal(config.fallbackModel, "other-model");
	assert.equal(config.maxSummaryTokens, 4096);
});

test("patterns replace instead of merging", () => {
	const { agentDir, cwd, env } = scaffold();
	writeGlobal(agentDir, { patterns: ["global_pattern"] });
	writeProject(cwd, { patterns: ["project_pattern"] });
	const { config } = loadConfig(cwd, env);
	assert.deepEqual(config.patterns, ["project_pattern"]);
});

test("a broken project file is reported and the global layer still applies", () => {
	const { agentDir, cwd, env } = scaffold();
	writeGlobal(agentDir, { fallbackProvider: "test-provider", fallbackModel: "test-model" });
	writeProject(cwd, "{ not json");
	const { config, warnings } = loadConfig(cwd, env);
	assert.equal(config.fallbackProvider, "test-provider");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /不是合法 JSON/);
});

test("a non-object top level is rejected", () => {
	const { cwd, env } = scaffold();
	writeProject(cwd, "[1, 2, 3]");
	const { config, warnings } = loadConfig(cwd, env);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.match(warnings[0] ?? "", /顶层必须是 JSON 对象/);
});

test("unknown keys are reported", () => {
	const { cwd, env } = scaffold();
	writeProject(cwd, { fallbackModel: "test-model", fallbackModle: "typo" });
	const { config, warnings } = loadConfig(cwd, env);
	assert.equal(config.fallbackModel, "test-model");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /fallbackModle/);
});

test("invalid values fall back to the default instead of wiping it", () => {
	const { cwd, env } = scaffold();
	writeProject(cwd, {
		fallbackProvider: "   ",
		autoRetry: "yes",
		patterns: [1, 2],
		thinkingLevel: "off",
		maxSummaryTokens: -5,
		maxConversationChars: 10,
		idleTimeoutMs: Number.NaN,
		promptTemplate: 42,
	});
	const { config, warnings } = loadConfig(cwd, env);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.equal(warnings.length, 8);
});

test("an idleTimeoutMs above the Node timer limit is capped, not turned into a 1 ms timer", () => {
	const { cwd, env } = scaffold();
	// Node rewrites a setTimeout delay above 2147483647 ms to 1 ms, which would abort every
	// fallback summary instantly; the cap keeps a long deadline a long deadline.
	writeProject(cwd, { idleTimeoutMs: MAX_TIMER_DELAY_MS + 1 });
	const { config, warnings } = loadConfig(cwd, env);
	assert.equal(config.idleTimeoutMs, MAX_TIMER_DELAY_MS);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /计时器上限/);

	// The largest representable delay itself is accepted unchanged.
	writeProject(cwd, { idleTimeoutMs: MAX_TIMER_DELAY_MS });
	const accepted = loadConfig(cwd, env);
	assert.equal(accepted.config.idleTimeoutMs, MAX_TIMER_DELAY_MS);
	assert.deepEqual(accepted.warnings, []);
});

test("valid thinking levels are accepted", () => {
	const { cwd, env } = scaffold();
	writeProject(cwd, { thinkingLevel: "low" });
	const { config, warnings } = loadConfig(cwd, env);
	assert.equal(config.thinkingLevel, "low");
	assert.deepEqual(warnings, []);
});

test("autoRetry false survives normalization", () => {
	const { cwd, env } = scaffold();
	writeProject(cwd, { autoRetry: false });
	const { config } = loadConfig(cwd, env);
	assert.equal(config.autoRetry, false);
});

test("config paths follow PI_CODING_AGENT_DIR and the project cwd", () => {
	const paths = resolveConfigPaths("/work/project", { PI_CODING_AGENT_DIR: "/custom/agent" });
	assert.equal(paths.global, join("/custom/agent", "cyber-compact-fallback.json"));
	assert.equal(paths.project, join("/work/project", ".pi", "cyber-compact-fallback.json"));
});

test("a missing or empty PI_CODING_AGENT_DIR keeps the default agent dir", () => {
	const expected = join(homedir(), ".pi", "agent");
	assert.equal(resolveAgentDir({}), expected);
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "" }), expected);
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "   " }), expected);
});

test("PI_CODING_AGENT_DIR expands ~ and ~/ like pi's getAgentDir", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~" }), homedir());
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/custom-agent" }), join(homedir(), "custom-agent"));

	// Absolute and relative paths are passed through unchanged, not resolved against the cwd.
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "relative/agent" }), "relative/agent");
	// `~name` is a path of its own, not a home reference.
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~name" }), "~name");

	// The Windows separator form expands on Windows only, exactly like the host.
	const windowsForm = resolveAgentDir({ PI_CODING_AGENT_DIR: "~\\custom-agent" });
	assert.equal(windowsForm, process.platform === "win32" ? join(homedir(), "custom-agent") : "~\\custom-agent");
});

test("resolveAgentDir agrees with the host's getAgentDir for every accepted form", () => {
	// The host reads process.env directly; compare it against the injectable version for the
	// shapes the compatibility fix promises: `~`, `~/…`, `~\…`, absolute, relative, empty.
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const value of ["~", "~/custom-agent", "~\\custom-agent", "/abs/agent", "rel/agent", "~name", ""]) {
			process.env.PI_CODING_AGENT_DIR = value;
			assert.equal(resolveAgentDir(), getAgentDir(), `PI_CODING_AGENT_DIR=${JSON.stringify(value)}`);
		}
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(resolveAgentDir(), getAgentDir());
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("config paths resolve a ~ override to the home directory", () => {
	const paths = resolveConfigPaths("/work/project", { PI_CODING_AGENT_DIR: "~/custom-agent" });
	assert.equal(paths.global, join(homedir(), "custom-agent", "cyber-compact-fallback.json"));
});
