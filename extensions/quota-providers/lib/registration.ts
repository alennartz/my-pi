import { existsSync, readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ModelEntry } from "./types.js";

// =============================================================================
// Model metadata
// =============================================================================

/** Per-million-token cost rates. */
type ModelCost = Model<Api>["cost"];

interface ModelMeta {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: ModelCost;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	forceAdaptiveThinking?: boolean;
}

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const DEFAULTS: ModelMeta = {
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 16384,
	cost: ZERO_COST,
};

/**
 * Resolve model metadata from pi-ai's built-in catalog. Unknown models or absent
 * catalogProvider fall back to conservative defaults.
 */
export function resolveModelMeta(
	catalogProvider: string | undefined,
	modelName: string,
): ModelMeta {
	if (!catalogProvider) return { ...DEFAULTS };
	const model = getBuiltinModel(catalogProvider as never, modelName as never);
	if (!model) return { ...DEFAULTS };
	return {
		reasoning: model.reasoning ?? false,
		input: model.input as ("text" | "image")[],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
		thinkingLevelMap: model.thinkingLevelMap,
		forceAdaptiveThinking: model.compat?.forceAdaptiveThinking,
	};
}

// =============================================================================
// Provider grouping
// =============================================================================

export interface ProviderGroup {
	providerId: string;
	api: Api;
	baseUrlPath: string;
	authHeader: boolean | undefined;
	models: ModelEntry[];
}

/**
 * Group ModelEntry[] by (api, baseUrlPath ?? "", authHeader ?? implAuthHeader).
 * Each group becomes one pi provider. When the same api splits across multiple
 * baseUrlPath/authHeader combinations, the second group is suffixed `-2`, the
 * third `-3`, etc.
 */
export function groupModels(
	implId: string,
	models: ModelEntry[],
	implAuthHeader?: boolean,
): ProviderGroup[] {
	// Map from group key → ProviderGroup (preserving insertion order)
	const byKey = new Map<string, ProviderGroup>();
	// Track how many groups exist per api so we can assign suffix numbers
	const apiCount = new Map<Api, number>();

	for (const entry of models) {
		const baseUrlPath = entry.baseUrlPath ?? "";
		const authHeader = entry.authHeader !== undefined ? entry.authHeader : implAuthHeader;
		const key = `${entry.api}\0${baseUrlPath}\0${String(authHeader)}`;

		if (!byKey.has(key)) {
			const count = (apiCount.get(entry.api) ?? 0) + 1;
			apiCount.set(entry.api, count);
			const providerId =
				count === 1 ? `${implId}-${entry.api}` : `${implId}-${entry.api}-${count}`;
			byKey.set(key, { providerId, api: entry.api, baseUrlPath, authHeader, models: [] });
		}
		byKey.get(key)!.models.push(entry);
	}

	return [...byKey.values()];
}

// =============================================================================
// Provider config
// =============================================================================

/**
 * Build the exact object for `pi.registerProvider(group.providerId, …)`.
 * Pure — does not call registerProvider itself.
 */
export function buildProviderConfig(
	impl: {
		id: string;
		name?: string;
		baseUrl: string;
		authHeader?: boolean;
		headers?: Record<string, string>;
	},
	group: ProviderGroup,
	apiKeyCommand: string,
): object {
	return {
		baseUrl: impl.baseUrl + (group.baseUrlPath ?? ""),
		apiKey: apiKeyCommand,
		authHeader: group.authHeader,
		...(impl.headers ? { headers: impl.headers } : {}),
		api: group.api,
		models: group.models.map((entry) => {
			const meta = resolveModelMeta(entry.catalogProvider, entry.modelName);
			return {
				id: entry.id,
				name: entry.id,
				reasoning: meta.reasoning,
				input: meta.input,
				cost: meta.cost,
				contextWindow: meta.contextWindow,
				maxTokens: meta.maxTokens,
				...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
				...(group.api === "anthropic-messages" && meta.forceAdaptiveThinking
					? { compat: { forceAdaptiveThinking: true } }
					: {}),
			};
		}),
	};
}

// =============================================================================
// Discovery cache
// =============================================================================

interface ModelsCache {
	writtenAt: number;
	models: ModelEntry[];
}

/**
 * Read the models discovery cache from disk. Returns null on missing, torn, or
 * garbage files — never throws.
 */
export function readModelsCache(path: string): { writtenAt: number; models: ModelEntry[] } | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsCache;
		if (Array.isArray(parsed?.models) && typeof parsed.writtenAt === "number") return parsed;
	} catch {
		// torn/garbage cache — treat as miss
	}
	return null;
}

// =============================================================================
// Refresh policy
// =============================================================================

/** Cold-start guard: skip background refresh if cache is younger than this. */
export const REFRESH_FLOOR_MS = 30_000;

/** /new or /reload guard: skip refresh if cache is younger than this. */
export const REFRESH_TTL_MS = 3_600_000;

/**
 * Returns true when a background discovery refresh should be kicked off.
 *
 * - firstRunInProcess (cold start): refresh whenever cache is older than REFRESH_FLOOR_MS
 * - subsequent runs (/new or /reload): refresh only when cache is older than REFRESH_TTL_MS
 */
export function discoveryRefreshDue(
	writtenAt: number,
	now: number,
	firstRunInProcess: boolean,
): boolean {
	const age = now - writtenAt;
	return firstRunInProcess ? age > REFRESH_FLOOR_MS : age > REFRESH_TTL_MS;
}
