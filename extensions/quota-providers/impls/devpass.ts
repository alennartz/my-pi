/**
 * LLM Gateway DevPass implementation for the quota-providers framework.
 *
 * Discovers the gateway catalog, keeping models with at least one upstream
 * provider that supports both streaming and tool calls. Since DevPass does not
 * allow provider pinning, the registered model keeps the canonical gateway ID;
 * Pi's displayed prices are the per-field medians across eligible providers.
 *
 * Authentication reuses LLMGATEWAY_API_KEY from the environment. GET /v1/key
 * reports monthly usage and a separate premium-weekly window. The monthly cycle
 * anchor is configurable because the endpoint does not report its renewal date.
 *
 * Thinking levels are derived from each eligible provider's declared
 * `reasoning_efforts` (see `buildThinkingLevelMap`), so pi only ever offers
 * effort values the gateway accepts.
 */

import type {
	ImplContext,
	ModelEntry,
	ProviderImplementation,
	TokenResult,
	UsageSnapshot,
} from "../lib/types.js";

const API_BASE_URL = "https://api.llmgateway.io/v1";
const API_KEY_ENV = "LLMGATEWAY_API_KEY";
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PER_TOKEN_TO_PER_MILLION = 1_000_000;
const PREMIUM_INPUT_USD_PER_MILLION = 5;
const PREMIUM_OUTPUT_USD_PER_MILLION = 15;
const PREMIUM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface GatewayProvider {
	streaming?: unknown;
	tools?: unknown;
	reasoning?: unknown;
	reasoning_efforts?: unknown;
	pricing?: unknown;
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

function ensureNotAborted(ctx: ImplContext): void {
	if (ctx.signal?.aborted) {
		throw new DOMException("devpass impl: operation aborted", "AbortError");
	}
}

function readApiKey(): string {
	const key = process.env[API_KEY_ENV]?.trim();
	if (!key) {
		throw new Error(`devpass impl: ${API_KEY_ENV} must be set`);
	}
	return key;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchGatewayJson(path: string, signal?: AbortSignal): Promise<unknown> {
	if (signal?.aborted) {
		throw new DOMException("devpass impl: operation aborted", "AbortError");
	}
	const response = await fetch(`${API_BASE_URL}${path}`, {
		headers: {
			Authorization: `Bearer ${readApiKey()}`,
			Accept: "application/json",
		},
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`devpass impl: GET ${path} failed (${response.status} ${response.statusText})`);
	}
	return response.json();
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

/** Gateway fair-use classification: premium at $5/M input or $15/M output. */
function isPremiumModel(modelPricing: unknown, eligiblePrices: ProviderPrice[]): boolean {
	const catalogPrice = asRecord(modelPricing) as ProviderPrice | undefined;
	const input = perMillion(
		parsePrice(catalogPrice?.prompt) ?? medianRate(eligiblePrices, "prompt"),
	);
	const output = perMillion(
		parsePrice(catalogPrice?.completion) ?? medianRate(eligiblePrices, "completion"),
	);
	return (input !== undefined && input >= PREMIUM_INPUT_USD_PER_MILLION) ||
		(output !== undefined && output >= PREMIUM_OUTPUT_USD_PER_MILLION);
}

function readBillingCycleAnchor(settings: Record<string, unknown>): number | undefined {
	const configured = settings.billingCycleAnchor;
	if (typeof configured !== "string" || configured.trim() === "") return undefined;

	let value = configured.trim();
	const envReference = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	if (envReference) {
		value = process.env[envReference[1]]?.trim() ?? "";
		if (!value) {
			throw new Error(`devpass impl: ${envReference[1]} must be set for billingCycleAnchor`);
		}
	}
	const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
	if (!parts) {
		throw new Error(
			"devpass impl: billingCycleAnchor must be an ISO-8601 UTC timestamp or a $ENV_VAR reference",
		);
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error("devpass impl: billingCycleAnchor is not a valid timestamp");
	}
	const parsed = new Date(timestamp);
	const expected = parts.slice(1, 7).map(Number);
	const milliseconds = Number((parts[7] ?? "").padEnd(3, "0"));
	if (
		parsed.getUTCFullYear() !== expected[0] ||
		parsed.getUTCMonth() + 1 !== expected[1] ||
		parsed.getUTCDate() !== expected[2] ||
		parsed.getUTCHours() !== expected[3] ||
		parsed.getUTCMinutes() !== expected[4] ||
		parsed.getUTCSeconds() !== expected[5] ||
		parsed.getUTCMilliseconds() !== milliseconds
	) {
		throw new Error("devpass impl: billingCycleAnchor is not a valid timestamp");
	}
	return timestamp;
}

function monthBoundary(anchor: Date, monthsAfterAnchor: number): number {
	const absoluteMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + monthsAfterAnchor;
	const year = Math.floor(absoluteMonth / 12);
	const month = absoluteMonth - year * 12;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const day = Math.min(anchor.getUTCDate(), lastDay);
	return Date.UTC(
		year,
		month,
		day,
		anchor.getUTCHours(),
		anchor.getUTCMinutes(),
		anchor.getUTCSeconds(),
		anchor.getUTCMilliseconds(),
	);
}

function monthlyWindow(anchorMs: number, now: number): { windowStart: number; windowEnd: number } {
	const anchor = new Date(anchorMs);
	const current = new Date(now);
	let months =
		(current.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
		(current.getUTCMonth() - anchor.getUTCMonth());
	let windowStart = monthBoundary(anchor, months);
	if (windowStart > now) {
		months -= 1;
		windowStart = monthBoundary(anchor, months);
	}
	return { windowStart, windowEnd: monthBoundary(anchor, months + 1) };
}


function usageAmount(data: Record<string, unknown>, field: string): number {
	const amount = parsePrice(data[field]);
	if (amount === undefined) {
		throw new Error(`devpass impl: /v1/key returned an invalid ${field}`);
	}
	return amount;
}

function premiumResetAt(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string" || !value.endsWith("Z")) {
		throw new Error("devpass impl: /v1/key returned an invalid premium reset timestamp");
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error("devpass impl: /v1/key returned an invalid premium reset timestamp");
	}
	return timestamp;
}

function buildUsageSnapshots(
	data: Record<string, unknown>,
	settings: Record<string, unknown>,
	now: number,
): UsageSnapshot[] {
	if (data.devPlan === "none") return [];

	const monthlySpend = usageAmount(data, "devPlanCreditsUsed");
	const monthlyQuota = usageAmount(data, "devPlanCreditsLimit");
	const anchor = readBillingCycleAnchor(settings);
	if (anchor === undefined) {
		throw new Error(
			"devpass impl: set billingCycleAnchor to a known monthly renewal boundary in ISO-8601 UTC",
		);
	}
	const monthlyBounds = monthlyWindow(anchor, now);
	const snapshots: UsageSnapshot[] = [{
		label: "Monthly",
		spend: monthlySpend,
		quota: monthlyQuota,
		windowStart: monthlyBounds.windowStart,
		windowEnd: monthlyBounds.windowEnd,
		asOf: now,
	}];

	const premiumQuota = usageAmount(data, "devPlanPremiumWeeklyLimit");
	if (premiumQuota > 0) {
		const reportedResetAt = premiumResetAt(data.devPlanPremiumWeekResetsAt);
		const resetAt = reportedResetAt !== undefined && reportedResetAt > now
			? reportedResetAt
			: now + PREMIUM_WINDOW_MS;
		snapshots.push({
			limitId: "premium-weekly",
			label: "Premium",
			spend: usageAmount(data, "devPlanPremiumCreditsUsed"),
			quota: premiumQuota,
			windowStart: resetAt - PREMIUM_WINDOW_MS,
			windowEnd: resetAt,
			asOf: now,
		});
	}

	return snapshots;
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
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string>>;

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
 * declarer's order. Providers that declare nothing don't constrain it;
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
 * Devpass cannot pin providers, so any eligible provider may serve a request;
 * only efforts every declaring provider agrees on are safe to send, and the
 * intersection is what gets mapped. Providers that declare nothing don't
 * constrain the result. When nothing is declared — or the agreement collapses
 * to disable-only values, where mapping every level would silently turn
 * thinking off — undefined is returned and pi keeps its default levels.
 *
 * Values are slotted onto pi's ordered ladder weakest → strongest: a value
 * named after a pi level claims that rung, unrecognized names take their
 * position from the catalog's own ordering, and rungs shift only as far as
 * needed to keep every catalog value in order. Each pi level then maps to the
 * weakest slot at or above its own (or the strongest value when none is), so
 * every level stays selectable and every sent value is declared-accepted.
 * "off" maps to a declared disable value; otherwise it stays unmapped, which
 * makes pi omit `reasoning_effort` entirely — accepted by every backend.
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
	if (disableIndex >= 0) {
		map.off = slotValues[disableIndex];
	}
	for (let levelIndex = 1; levelIndex < THINKING_LEVELS.length; levelIndex++) {
		const slot = slots.findIndex((rung) => rung >= levelIndex);
		map[THINKING_LEVELS[levelIndex]] =
			slot >= 0 ? slotValues[slot] : slotValues[slotValues.length - 1];
	}
	return map;
}

/**
 * Convert raw `/v1/models` records into Pi model entries. Invalid records and
 * models with no streaming+tools provider are skipped. Per-token gateway prices
 * are converted to Pi's per-million-token cost rates after taking field medians.
 */
export function buildModelEntries(records: unknown[]): ModelEntry[] {
	const entries: ModelEntry[] = [];
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

		const prices = eligibleProviders
			.map((provider) => asRecord(provider.pricing) as ProviderPrice | undefined)
			.filter((price): price is ProviderPrice => price !== undefined);
		if (prices.length === 0) continue;

		const inputRate = medianRate(prices, "prompt");
		const outputRate = medianRate(prices, "completion");
		if (inputRate === undefined || outputRate === undefined) continue;
		const input = perMillion(inputRate);
		const output = perMillion(outputRate);
		const cacheRead = perMillion(
			medianRate(prices, "input_cache_read") ?? inputRate,
		);
		// Pi exposes one cache-write rate. Prefer the gateway's default write tier;
		// use the 1-hour tier only when no eligible provider reports the default.
		const cacheWrite = perMillion(
			medianRate(prices, "input_cache_write") ?? medianRate(prices, "input_cache_write_1h"),
		);
		const contextWindow = positiveNumber(model.context_length);
		const maxTokens = positiveNumber(model.max_output);
		const reasoning = modelSupportsReasoning(model, eligibleProviders);
		const thinkingLevelMap = reasoning ? buildThinkingLevelMap(eligibleProviders) : undefined;
		const quotaLimitIds = isPremiumModel(model.pricing, prices) ? ["premium-weekly"] : undefined;
		const cost: NonNullable<ModelEntry["cost"]> = {
			...(input !== undefined ? { input } : {}),
			...(output !== undefined ? { output } : {}),
			...(cacheRead !== undefined ? { cacheRead } : {}),
			...(cacheWrite !== undefined ? { cacheWrite } : {}),
		};

		const entry: ModelEntry = {
			id: model.id,
			name: typeof model.display_name === "string" && model.display_name.length > 0
				? model.display_name
				: model.id,
			modelName: model.id,
			api: "openai-completions",
			authHeader: true,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: modelInput(model),
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(quotaLimitIds ? { quotaLimitIds } : {}),
			...(Object.keys(cost).length > 0 ? { cost } : {}),
		};
		entries.push(entry);
	}
	return entries;
}

const impl: ProviderImplementation = {
	id: "devpass",
	name: "LLM Gateway DevPass",
	baseUrl: API_BASE_URL,
	authHeader: true,

	async discoverModels(ctx: ImplContext): Promise<ModelEntry[]> {
		ensureNotAborted(ctx);
		const payload = asRecord(await fetchGatewayJson("/models", ctx.signal));
		if (!payload || !Array.isArray(payload.data)) {
			throw new Error("devpass impl: /v1/models response did not contain a data array");
		}
		return buildModelEntries(payload.data);
	},

	async getToken(ctx: ImplContext): Promise<TokenResult> {
		ensureNotAborted(ctx);
		return {
			token: readApiKey(),
			// The gateway key has no expiry field; periodically reread the env var
			// so a rotated key is picked up without restarting the pi process.
			expiresAt: Date.now() + TOKEN_LIFETIME_MS,
		};
	},

	async getUsage(ctx: ImplContext): Promise<UsageSnapshot[]> {
		ensureNotAborted(ctx);
		const payload = asRecord(await fetchGatewayJson("/key", ctx.signal));
		const data = asRecord(payload?.data);
		if (!data) {
			throw new Error("devpass impl: /v1/key response did not contain a data object");
		}
		return buildUsageSnapshots(data, ctx.settings, Date.now());
	},
};

export default impl;
