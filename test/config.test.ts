import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadConfig, resolveConfigPaths } from "../src/config.ts";
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
