/**
 * A provider-wide usage snapshot. Limit IDs stay opaque to the quota core; the
 * source owns the association between model IDs and any scoped budgets.
 */
export interface UsageSnapshot {
	/** Optional limit ID. Omitted applies to every model on the provider. */
	limitId?: string;
	/** Short label for the quota window shown in status output. */
	label?: string;
	/** Window-to-date spend, dollars. */
	spend: number;
	/** Window hard limit, dollars. */
	quota: number;
	/** Epoch ms. */
	windowStart: number;
	/** Epoch ms — reset time. */
	windowEnd: number;
	/** Epoch ms. Semantics: `spend` is authoritative up to this time. Real-time
	 * providers return `now`; providers with laggy reporting return
	 * `now − lagEstimate`. Drives ledger pruning. */
	asOf: number;
}

/**
 * One provider-wide usage poll. Limit IDs stay opaque to the quota core; the
 * source owns the association between model IDs and any scoped budgets.
 */
export interface QuotaSourceResult {
	snapshots: UsageSnapshot[];
	modelLimitIds: Record<string, string[]>;
}

/**
 * Provider-specific usage adapter loaded by the quota-providers extension.
 * A quota source does not discover models, obtain API tokens, or register a
 * pi provider.
 */
export interface QuotaSource {
	getUsage(context: ImplContext): Promise<QuotaSourceResult>;
}

export interface ImplContext {
	/** The attachment's config block (source-specific settings pass through untouched). */
	settings: Record<string, unknown>;

	/**
	 * Optional cancellation signal for usage polling. Sources should observe it
	 * and pass it to async underpinnings when possible.
	 */
	signal?: AbortSignal;
}

// Internal core types — used by quota-providers core, not exposed to sources.

export interface LedgerEntry {
	timestamp: number;
	cost: number;
	/** Opaque limit IDs assigned to the model that produced this cost. */
	quotaLimitIds?: string[];
}

export interface QuotaVerdict {
	state: "ok" | "soft-exceeded" | "hard-exceeded";
	/** How far ahead of budget, in days (can be negative = under budget). */
	daysAhead: number;
	/** Epoch ms — when the quota window resets. */
	resetAt: number;
}

export interface QuotaPolicy {
	bypassAllowed: boolean;
	lookaheadHours: number;
	maxPollSeconds: number;
	enforceHardCap: boolean;
}
