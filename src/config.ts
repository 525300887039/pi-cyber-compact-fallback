/**
 * Configuration loading: global layer, then optional per-project override.
 *
 * The config is re-read on every use, so editing the file takes effect on the next
 * compaction without restarting pi. Nothing here is cached and nothing is ever written back.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	CONFIG_FILENAME,
	DEFAULT_CONFIG,
	THINKING_LEVELS,
	type FallbackConfig,
	type ThinkingLevel,
} from "./types.ts";

export interface ConfigPaths {
	global: string;
	project: string;
}

export interface LoadedConfig {
	config: FallbackConfig;
	paths: ConfigPaths;
	/** Human-readable problems; the caller decides how (and how often) to surface them. */
	warnings: string[];
}

const KNOWN_KEYS = new Set<keyof FallbackConfig>([
	"fallbackProvider",
	"fallbackModel",
	"autoRetry",
	"patterns",
	"caseInsensitive",
	"thinkingLevel",
	"maxSummaryTokens",
	"maxConversationChars",
	"idleTimeoutMs",
	"promptTemplate",
]);

/**
 * Node rewrites a `setTimeout` delay above this to 1 ms (with a `TimeoutOverflowWarning`), which
 * would turn a long request deadline into an instant abort. `idleTimeoutMs` feeds a timer, so
 * values above the largest representable delay are capped instead of accepted as-is.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (!override || override.trim() === "") return join(homedir(), ".pi", "agent");
	// Same expansion pi's own `getAgentDir` performs (`~`, `~/…`, and `~\…` on Windows): an
	// unexpanded `~/…` would otherwise be read as a path relative to the process cwd. Absolute
	// and relative paths are passed through unchanged, exactly like the host does.
	if (override === "~") return homedir();
	if (override.startsWith("~/") || (process.platform === "win32" && override.startsWith("~\\"))) {
		return join(homedir(), override.slice(2));
	}
	return override;
}

export function resolveConfigPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): ConfigPaths {
	return {
		global: join(resolveAgentDir(env), CONFIG_FILENAME),
		project: join(cwd, ".pi", CONFIG_FILENAME),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readLayer(path: string, warnings: string[]): Partial<FallbackConfig> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		// A missing file is the normal case, not a problem.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(`无法读取 ${path}：${errorMessage(error)}`);
		}
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		warnings.push(`${path} 不是合法 JSON，已忽略：${errorMessage(error)}`);
		return {};
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		warnings.push(`${path} 顶层必须是 JSON 对象，已忽略`);
		return {};
	}

	return normalizeLayer(parsed as Record<string, unknown>, path, warnings);
}

function normalizeLayer(raw: Record<string, unknown>, path: string, warnings: string[]): Partial<FallbackConfig> {
	const out: Partial<FallbackConfig> = {};

	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.has(key as keyof FallbackConfig)) {
			warnings.push(`${path} 含未知配置项 "${key}"，已忽略（可能是拼写错误）`);
		}
	}

	const stringField = (key: "fallbackProvider" | "fallbackModel"): void => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value === "string" && value.trim() !== "") {
			out[key] = value.trim();
		} else {
			warnings.push(`${path} 的 ${key} 必须是非空字符串，已忽略`);
		}
	};
	stringField("fallbackProvider");
	stringField("fallbackModel");

	if (raw.autoRetry !== undefined) {
		if (typeof raw.autoRetry === "boolean") out.autoRetry = raw.autoRetry;
		else warnings.push(`${path} 的 autoRetry 必须是布尔值，已忽略`);
	}

	if (raw.caseInsensitive !== undefined) {
		if (typeof raw.caseInsensitive === "boolean") out.caseInsensitive = raw.caseInsensitive;
		else warnings.push(`${path} 的 caseInsensitive 必须是布尔值，已忽略`);
	}

	if (raw.patterns !== undefined) {
		if (Array.isArray(raw.patterns) && raw.patterns.every((item) => typeof item === "string" && item !== "")) {
			// Arrays replace, they never merge: a project layer must be able to drop a default rule.
			out.patterns = raw.patterns as string[];
		} else {
			warnings.push(`${path} 的 patterns 必须是非空字符串数组，已忽略`);
		}
	}

	if (raw.thinkingLevel !== undefined) {
		const value = raw.thinkingLevel;
		if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
			out.thinkingLevel = value as ThinkingLevel;
		} else {
			warnings.push(`${path} 的 thinkingLevel 必须是 ${THINKING_LEVELS.join(" | ")} 之一，已忽略`);
		}
	}

	const positiveNumber = (
		key: "maxSummaryTokens" | "maxConversationChars" | "idleTimeoutMs",
		min: number,
		max?: number,
	): void => {
		const value = raw[key];
		if (value === undefined) return;
		if (typeof value === "number" && Number.isFinite(value) && value >= min) {
			if (max !== undefined && value > max) {
				warnings.push(`${path} 的 ${key} 超过 Node 计时器上限 ${max}ms，已按上限处理`);
				out[key] = max;
			} else {
				out[key] = value;
			}
		} else {
			warnings.push(`${path} 的 ${key} 必须是不小于 ${min} 的数字，已忽略`);
		}
	};
	positiveNumber("maxSummaryTokens", 1);
	positiveNumber("maxConversationChars", 1_000);
	positiveNumber("idleTimeoutMs", 0, MAX_TIMER_DELAY_MS);

	if (raw.promptTemplate !== undefined) {
		const value = raw.promptTemplate;
		if (value === null) out.promptTemplate = null;
		else if (typeof value === "string" && value.trim() !== "") out.promptTemplate = value;
		else warnings.push(`${path} 的 promptTemplate 必须是字符串或 null，已忽略`);
	}

	return out;
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
	const paths = resolveConfigPaths(cwd, env);
	const warnings: string[] = [];

	const globalLayer = readLayer(paths.global, warnings);
	const projectLayer = readLayer(paths.project, warnings);

	// Shallow merge, project wins. Only explicitly provided keys land in a layer,
	// so an invalid value falls back to the default instead of wiping it.
	return {
		config: { ...DEFAULT_CONFIG, ...globalLayer, ...projectLayer },
		paths,
		warnings,
	};
}
