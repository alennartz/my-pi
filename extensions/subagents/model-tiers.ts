/**
 * Model intelligence tiers — named tiers (`cheap`, `medium`, `smart`,
 * `frontier`) that resolve to concrete model IDs from a JSON config at spawn
 * time. Tier names are the advertised vocabulary for the `subagent` tool's
 * `model` field and agent-definition pins; the system prompt injects a
 * four-row tier table rendered by `renderTierTable`.
 *
 * Pure functions except `loadTierConfig`, which reads the two config files
 * (global then project overlay) and tolerates every malformed input by
 * dropping bad entries — it never throws.
 */

import * as fs from "node:fs";

export const TIER_NAMES = ["cheap", "medium", "smart", "frontier"] as const;

/** The six pi thinking levels, mirrored locally for suffix validation. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(s: string): s is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(s);
}

/**
 * Split a trailing ":<valid-level>" off a model pattern, mirroring pi's
 * split-on-last-colon. Only splits when the suffix is one of the six levels,
 * so colon-bearing model ids (e.g. OpenRouter "openai/gpt-x:exacto") are left
 * whole. Returns the model part and the level (if any).
 *
 * Examples:
 *   "anthropic/claude-opus-4-8:xhigh" → { model: "anthropic/claude-opus-4-8", thinking: "xhigh" }
 *   "openai/gpt-5.4:exacto"           → { model: "openai/gpt-5.4:exacto" }  (not a level)
 *   "anthropic/claude-opus-4-8"       → { model: "anthropic/claude-opus-4-8" }
 */
export function stripThinkingSuffix(pattern: string): { model: string; thinking?: ThinkingLevel } {
	const lastColon = pattern.lastIndexOf(":");
	if (lastColon === -1) return { model: pattern };
	const suffix = pattern.slice(lastColon + 1);
	if (!isThinkingLevel(suffix)) return { model: pattern };
	return { model: pattern.slice(0, lastColon), thinking: suffix };
}
export type TierName = (typeof TIER_NAMES)[number];

/**
 * Label used when the concrete session-default model id is unknown (i.e.
 * `ctx.model` is undefined at injection time). Rendered without code
 * backticks so it never reads as a real model id an LLM could echo back.
 */
export const SESSION_DEFAULT_LABEL = "session default";

/** Flat tier→model-id map; any subset of tiers may be configured. */
export type TierConfig = Partial<Record<TierName, string>>;

export function isTierName(ref: string): ref is TierName {
	return (TIER_NAMES as readonly string[]).includes(ref);
}

/**
 * Read global config then overlay project config.
 * - globalPath: <agentDir>/model-tiers.json (agentDir = ~/.pi/agent)
 * - projectPath: <cwd>/.pi/model-tiers.json, honored only when projectTrusted
 * Missing files, unparseable JSON, non-string values, and unknown keys are
 * tolerated: bad entries are dropped, never thrown. Returns {} at worst.
 */
export function loadTierConfig(opts: {
	globalPath: string;
	projectPath: string;
	projectTrusted: boolean;
}): TierConfig {
	const global = readTierFile(opts.globalPath);
	const project = opts.projectTrusted ? readTierFile(opts.projectPath) : {};
	return { ...global, ...project };
}

/** Read one config file; any error yields an empty contribution. */
function readTierFile(filePath: string): TierConfig {
	try {
		return sanitize(JSON.parse(fs.readFileSync(filePath, "utf-8")));
	} catch {
		return {};
	}
}

/** Keep only known tier keys with string values; drop everything else. */
function sanitize(parsed: unknown): TierConfig {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const config: TierConfig = {};
	for (const name of TIER_NAMES) {
		const value = (parsed as Record<string, unknown>)[name];
		if (typeof value === "string") config[name] = value;
	}
	return config;
}

/**
 * Resolution result for a `model` field value (tool override or agent pin).
 * - ref is a tier name, tier configured and model available   → { model: <configured id> }
 * - ref is a tier name, unconfigured or model unavailable     → { model: undefined, warning? }
 *   (undefined = no --model override; child uses session default)
 * - ref is not a tier name                                    → { model: ref } (passthrough,
 *   existing isValidModelRef validation applies unchanged)
 * `warning` is present only for a configured tier whose model is not in the
 * available set per `isAvailable`. The entirely-unconfigured case (empty
 * TierConfig) is not a per-call warning: the integration layer emits one
 * session-level notice.
 */
export function resolveModelRef(
	ref: string,
	tiers: TierConfig,
	isAvailable: (ref: string) => boolean,
): { model: string | undefined; warning?: string } {
	if (!isTierName(ref)) return { model: ref };
	const configured = tiers[ref];
	if (configured === undefined) return { model: undefined };
	// Availability is judged on the model part alone; the full suffixed string
	// (including any thinking level) is returned as-is when available.
	const { model: modelPart } = stripThinkingSuffix(configured);
	if (isAvailable(modelPart)) return { model: configured };
	return {
		model: undefined,
		warning: `Model tier "${ref}" is configured as "${modelPart}", which is not available; using the session default model.`,
	};
}

/**
 * Render the tier table lines for system-prompt injection. Each configured
 * tier shows its resolved model id; unconfigured/unavailable tiers show the
 * concrete session-default model id with a "(default)" marker, so transcripts
 * always record which model a tier-named spawn actually used. Pure — returns
 * string[].
 */
export function renderTierTable(
	tiers: TierConfig,
	isAvailable: (ref: string) => boolean,
	defaultModelRef: string,
): string[] {
	const lines = ["| Tier | Model |", "| --- | --- |"];
	for (const name of TIER_NAMES) {
		const configured = tiers[name];
		const modelPart = configured !== undefined ? stripThinkingSuffix(configured).model : undefined;
		if (configured !== undefined && modelPart !== undefined && isAvailable(modelPart)) {
			lines.push(`| ${name} | \`${configured}\` |`);
		} else if (defaultModelRef === SESSION_DEFAULT_LABEL) {
			// Unknown concrete model — render the plain label, no backticks, so
			// it isn't mistaken for a real model id.
			lines.push(`| ${name} | ${defaultModelRef} (default) |`);
		} else {
			lines.push(`| ${name} | \`${defaultModelRef}\` (default) |`);
		}
	}
	return lines;
}
