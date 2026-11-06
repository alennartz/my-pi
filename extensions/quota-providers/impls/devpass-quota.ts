import type { QuotaSource, ImplContext, UsageSnapshot } from "../lib/types.js";
import { findPremiumModelIds } from "../../llm-gateway/catalog.js";

const API_BASE_URL = "https://api.llmgateway.io/v1";
const API_KEY_ENV = "LLMGATEWAY_API_KEY";
const REQUEST_TIMEOUT_MS = 30_000;
const PREMIUM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function ensureNotAborted(context: ImplContext): void {
	if (context.signal?.aborted) {
		throw new DOMException("devpass quota: operation aborted", "AbortError");
	}
}

function readApiKey(): string {
	const key = process.env[API_KEY_ENV]?.trim();
	if (!key) throw new Error(`devpass quota: ${API_KEY_ENV} must be set`);
	return key;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchGatewayJson(path: string, signal?: AbortSignal): Promise<unknown> {
	if (signal?.aborted) {
		throw new DOMException("devpass quota: operation aborted", "AbortError");
	}
	const response = await fetch(`${API_BASE_URL}${path}`, {
		headers: {
			Authorization: `Bearer ${readApiKey()}`,
			Accept: "application/json",
		},
		signal: requestSignal(signal),
	});
	if (!response.ok) {
		throw new Error(`devpass quota: GET ${path} failed (${response.status} ${response.statusText})`);
	}
	return response.json();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function parseNumber(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	if (typeof value === "string" && value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function usageAmount(data: Record<string, unknown>, field: string): number {
	const amount = parseNumber(data[field]);
	if (amount === undefined) {
		throw new Error(`devpass quota: /v1/key returned an invalid ${field}`);
	}
	return amount;
}

function readBillingCycleAnchor(settings: Record<string, unknown>): number | undefined {
	const configured = settings.billingCycleAnchor;
	if (typeof configured !== "string" || configured.trim() === "") return undefined;

	let value = configured.trim();
	const envReference = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	if (envReference) {
		value = process.env[envReference[1]]?.trim() ?? "";
		if (!value) {
			throw new Error(`devpass quota: ${envReference[1]} must be set for billingCycleAnchor`);
		}
	}
	const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
	if (!parts) {
		throw new Error(
			"devpass quota: billingCycleAnchor must be an ISO-8601 UTC timestamp or a $ENV_VAR reference",
		);
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error("devpass quota: billingCycleAnchor is not a valid timestamp");
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
		throw new Error("devpass quota: billingCycleAnchor is not a valid timestamp");
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

function premiumResetAt(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string" || !value.endsWith("Z")) {
		throw new Error("devpass quota: /v1/key returned an invalid premium reset timestamp");
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error("devpass quota: /v1/key returned an invalid premium reset timestamp");
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
			"devpass quota: set billingCycleAnchor to a known monthly renewal boundary in ISO-8601 UTC",
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

async function readUsage(context: ImplContext) {
	ensureNotAborted(context);
	const keyPayload = asRecord(await fetchGatewayJson("/key", context.signal));
	const keyData = asRecord(keyPayload?.data);
	if (!keyData) {
		throw new Error("devpass quota: /v1/key response did not contain a data object");
	}

	ensureNotAborted(context);
	const catalogPayload = asRecord(await fetchGatewayJson("/models", context.signal));
	if (!catalogPayload || !Array.isArray(catalogPayload.data)) {
		throw new Error("devpass quota: /v1/models response did not contain a data array");
	}

	const now = Date.now();
	return {
		snapshots: buildUsageSnapshots(keyData, context.settings, now),
		modelLimitIds: findPremiumModelIds(catalogPayload.data),
	};
}

const devpassQuota: QuotaSource = { getUsage: readUsage };

export default devpassQuota;
