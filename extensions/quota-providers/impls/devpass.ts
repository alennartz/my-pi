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
			label: "Premium weekly",
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
			reasoning: modelSupportsReasoning(model, eligibleProviders),
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
