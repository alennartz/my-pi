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

export const TIER_NAMES = ["cheap", "medium", "smart", "frontier"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** Flat tier→model-id map; any subset of tiers may be configured. */
export type TierConfig = Partial<Record<TierName, string>>;

export function isTierName(ref: string): ref is TierName {
	throw new Error("not implemented");
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
	throw new Error("not implemented");
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
	throw new Error("not implemented");
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
	throw new Error("not implemented");
}
