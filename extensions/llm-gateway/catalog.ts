import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PER_TOKEN_TO_PER_MILLION = 1_000_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

interface GatewayProvider {
	streaming?: unknown;
	tools?: unknown;
	reasoning?: unknown;
	reasoning_efforts?: unknown;
	pricing?: unknown;
	max_output?: unknown;
}

interface GatewayModel {
	id?: unknown;
	display_name?: unknown;
	architecture?: unknown;
	providers?: unknown;
	pricing?: unknown;
	context_length?: unknown;
	max_output?: unknown;
	supported_parameters?: unknown;
}

interface ProviderPrice {
	prompt?: unknown;
	completion?: unknown;
	input_cache_read?: unknown;
	input_cache_write?: unknown;
	input_cache_write_1h?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function asProvider(value: unknown): GatewayProvider | undefined {
	const record = asRecord(value);
	return record ? record as GatewayProvider : undefined;
}

function parsePrice(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	if (typeof value === "string" && value.trim() === "") return undefined;
	const price = Number(value);
	return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianRate(prices: ProviderPrice[], key: keyof ProviderPrice): number | undefined {
	return median(
		prices
			.map((price) => parsePrice(price[key]))
			.filter((price): price is number => price !== undefined),
	);
}

function perMillion(rate: number | undefined): number | undefined {
	return rate === undefined ? undefined : rate * PER_TOKEN_TO_PER_MILLION;
}

function providerPrices(providers: GatewayProvider[]): ProviderPrice[] {
	return providers
		.map((provider) => asRecord(provider.pricing) as ProviderPrice | undefined)
		.filter((price): price is ProviderPrice => price !== undefined);
}

function modelInput(model: GatewayModel): ("text" | "image")[] {
	const architecture = asRecord(model.architecture);
	const modalities = architecture?.input_modalities;
	if (!Array.isArray(modalities)) return ["text"];
	const supported = modalities.filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	return supported.length > 0 ? supported : ["text"];
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Smallest declared value, ignoring undefined — undefined when none is declared. */
function minDeclared(values: (number | undefined)[]): number | undefined {
	const declared = values.filter((value): value is number => value !== undefined);
	return declared.length > 0 ? Math.min(...declared) : undefined;
}

/**
 * pi-ai's standard cache-safe image profile (its own generated catalogs use
 * exactly this for openai-completions vision models); pi resizes tool-result
 * images with it before they enter conversation history.
 */
const IMAGE_RESIZE = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 };

function modelSupportsReasoning(
	model: GatewayModel,
	eligibleProviders: GatewayProvider[],
): boolean {
	if (Array.isArray(model.supported_parameters)) {
		return model.supported_parameters.includes("reasoning");
	}
	return eligibleProviders.every((provider) => provider.reasoning === true);
}

/** pi thinking levels ordered weakest → strongest, mirroring pi-ai's ladder. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string>>;

/** Provider effort values that mean "thinking disabled" — pi's "off" slot. */
const DISABLE_VALUES = new Set(["off", "none", "disable", "disabled"]);

function normalizeEffort(value: string): string {
	return value.trim().toLowerCase();
}

/** The provider's declared effort list, or undefined when it declares none. */
function declaredEfforts(provider: GatewayProvider): string[] | undefined {
	if (!Array.isArray(provider.reasoning_efforts)) return undefined;
	const values = provider.reasoning_efforts
		.filter((value): value is string =>
			typeof value === "string" && normalizeEffort(value).length > 0)
		.map((value) => value.trim());
	return values.length > 0 ? values : undefined;
}

/**
 * Efforts every declaring eligible provider agrees on, preserving the first
 * declarer's order. Providers that declare nothing do not constrain it;
 * undefined means no provider declared anything.
 */
function agreedEfforts(eligibleProviders: GatewayProvider[]): string[] | undefined {
	let agreed: string[] | undefined;
	for (const provider of eligibleProviders) {
		const declared = declaredEfforts(provider);
		if (!declared) continue;
		agreed = agreed === undefined
			? declared
			: declared.filter((value) =>
				agreed!.some((kept) => normalizeEffort(kept) === normalizeEffort(value)));
	}
	return agreed;
}

/** Ladder rung of an effort value, or -1 when the name is not a pi level. */
function effortRank(value: string): number {
	const normalized = normalizeEffort(value);
	if (DISABLE_VALUES.has(normalized)) return 0;
	return THINKING_LEVELS.indexOf(normalized as ThinkingLevel);
}

/**
 * Build a pi `thinkingLevelMap` from the efforts the gateway catalog declares.
 *
 * DevPass cannot pin providers, so any eligible provider may serve a request;
 * only efforts every declaring provider agrees on are safe to send, and the
 * intersection is what gets mapped. Providers that declare nothing do not
 * constrain the result. When nothing is declared — or the agreement collapses
 * to disable-only values, where mapping every level would silently turn
 * thinking off — undefined is returned and pi keeps its default levels.
 */
export function buildThinkingLevelMap(eligibleProviders: GatewayProvider[]): ThinkingLevelMap | undefined {
	const agreed = agreedEfforts(eligibleProviders);
	if (!agreed) return undefined;

	// Canonical ladder order when every name is known; otherwise trust the
	// catalog's own ordering (it lists efforts weakest → strongest).
	const allKnown = agreed.every((value) => effortRank(value) >= 0);
	const values = allKnown ? [...agreed].sort((a, b) => effortRank(a) - effortRank(b)) : agreed;
	if (values.length > THINKING_LEVELS.length) return undefined;
	if (values.every((value) => DISABLE_VALUES.has(normalizeEffort(value)))) return undefined;

	// Preferred rung per value: name match, else position along the ladder.
	const preferred = values.map((value, index) => {
		const rank = effortRank(value);
		if (rank >= 0) return rank;
		return values.length === 1
			? Math.floor((THINKING_LEVELS.length - 1) / 2)
			: Math.round((index * (THINKING_LEVELS.length - 1)) / (values.length - 1));
	});
	// Duplicate rungs (e.g. both "off" and "none") keep only the first claim.
	const slots: number[] = [];
	const slotValues: string[] = [];
	preferred.forEach((rank, index) => {
		if (allKnown && slots.includes(rank)) return;
		slots.push(rank);
		slotValues.push(values[index]);
	});

	// Fit every value into distinct, ascending rungs, disaligning name matches
	// only as far as needed to keep them in order.
	for (let index = 0; index < slots.length; index++) {
		slots[index] = Math.max(slots[index], index, (slots[index - 1] ?? -1) + 1);
	}
	for (let index = slots.length - 1; index >= 0; index--) {
		const ceiling = index === slots.length - 1 ? THINKING_LEVELS.length - 1 : slots[index + 1] - 1;
		slots[index] = Math.max(index, Math.min(slots[index], ceiling));
	}

	const map: ThinkingLevelMap = {};
	const disableIndex = slotValues.findIndex((value, index) =>
		slots[index] === 0 && DISABLE_VALUES.has(normalizeEffort(value)));
	if (disableIndex >= 0) map.off = slotValues[disableIndex];
	for (let levelIndex = 1; levelIndex < THINKING_LEVELS.length; levelIndex++) {
		const slot = slots.findIndex((rung) => rung >= levelIndex);
		map[THINKING_LEVELS[levelIndex]] =
			slot >= 0 ? slotValues[slot] : slotValues[slotValues.length - 1];
	}
	return map;
}

/**
 * Convert raw `/v1/models` records into pi provider model configurations.
 * Invalid records and models with no streaming+tools provider are skipped.
 * Per-token gateway prices are converted to per-million-token rates after
 * taking field medians across eligible providers.
 */
export function buildProviderModelConfigs(records: unknown[]): ProviderModelConfig[] {
	const entries: ProviderModelConfig[] = [];
	for (const raw of records) {
		const model = asRecord(raw) as GatewayModel | undefined;
		if (!model || typeof model.id !== "string" || model.id.length === 0) continue;
		if (!Array.isArray(model.providers)) continue;

		const eligibleProviders = model.providers
			.map(asProvider)
			.filter((provider): provider is GatewayProvider =>
				provider !== undefined && provider.streaming === true && provider.tools === true,
			);
		if (eligibleProviders.length === 0) continue;

		const prices = providerPrices(eligibleProviders);
		const inputRate = medianRate(prices, "prompt");
		const outputRate = medianRate(prices, "completion");
		if (inputRate === undefined || outputRate === undefined) continue;
		const input = perMillion(inputRate)!;
		const output = perMillion(outputRate)!;
		const cacheRead = perMillion(medianRate(prices, "input_cache_read") ?? inputRate)!;
		// Pi exposes one cache-write rate. Prefer the gateway's default write tier;
		// use the 1-hour tier only when no eligible provider reports the default.
		const cacheWrite = perMillion(
			medianRate(prices, "input_cache_write") ?? medianRate(prices, "input_cache_write_1h") ?? inputRate,
		)!;
		const contextWindow = positiveNumber(model.context_length) ?? DEFAULT_CONTEXT_WINDOW;
		// DevPass cannot pin providers: a request may land on any eligible one,
		// and max_tokens above a provider's cap is rejected (or makes the model
		// unroutable). The ceiling is the smallest declared value across the
		// model record and every eligible provider; when nothing is declared,
		// pi's configured default applies.
		const maxTokens = minDeclared([
			positiveNumber(model.max_output),
			...eligibleProviders.map((provider) => positiveNumber(provider.max_output)),
		]) ?? DEFAULT_MAX_TOKENS;
		const inputModalities = modelInput(model);
		const inputLimits: ProviderModelConfig["inputLimits"] =
			inputModalities.includes("image") ? { images: { resize: IMAGE_RESIZE } } : undefined;
		const reasoning = modelSupportsReasoning(model, eligibleProviders);
		const thinkingLevelMap = reasoning ? buildThinkingLevelMap(eligibleProviders) : undefined;

		const entry: ProviderModelConfig = {
			id: model.id,
			name: typeof model.display_name === "string" && model.display_name.length > 0
				? model.display_name
				: model.id,
			api: "openai-completions",
			reasoning,
			input: inputModalities,
			contextWindow,
			maxTokens,
			cost: { input, output, cacheRead, cacheWrite },
			...(inputLimits ? { inputLimits } : {}),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		};
		entries.push(entry);
	}
	return entries;
}

/** Compatibility name for callers that still refer to catalog entries. */
export const buildModelEntries = buildProviderModelConfigs;
