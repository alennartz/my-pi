import type { Api } from "@earendil-works/pi-ai";

// =============================================================================
// Seam types — the interface between the core and out-of-repo implementations.
// Out-of-repo implementations import only via `import type` so there is no
// runtime path coupling to this repo.
// =============================================================================

/** Default export of an implementation module. */
export interface ProviderImplementation {
  /** Provider id prefix, e.g. "azure-foundry". Also the cache-dir key. */
  id: string;
  /** Display name for registered providers. */
  name?: string;
  /** Base endpoint, e.g. "https://x.services.ai.azure.com". */
  baseUrl: string;
  /** Whether pi should add `Authorization: Bearer <token>`. May vary per model via ModelEntry. */
  authHeader?: boolean;

  /** Seam 1: fetch the raw model list. Runs out-of-band in the runner. */
  discoverModels(ctx: ImplContext): Promise<ModelEntry[]>;
  /** Seam 2: fetch a fresh token. Runs out-of-band in the runner; core owns caching/margins. */
  getToken(ctx: ImplContext): Promise<TokenResult>;
  /** Seam 3 (optional): report provider usage facts. Absent → no quota enforcement for this provider. */
  getUsage?(ctx: ImplContext): Promise<UsageSnapshot>;
}

export interface ModelEntry {
  /** Model/deployment id sent to the API. */
  id: string;
  /** Catalog key for pi-ai metadata lookup (context window, cost, compat). */
  modelName: string;
  /** Full pi-ai Api union — core passes it through to pi.registerProvider. */
  api: Api;
  /** Which pi-ai catalog provider to resolve modelName against (e.g. "anthropic",
   *  "azure-openai-responses"). Absent or miss → conservative defaults. */
  catalogProvider?: string;
  /** Appended to baseUrl for this model's backend, e.g. "/anthropic". */
  baseUrlPath?: string;
  /** Per-model authHeader override. */
  authHeader?: boolean;
}

export interface TokenResult {
  token: string;
  /** Epoch ms. Core applies soft/hard refresh margins and caching. */
  expiresAt: number;
}

export interface UsageSnapshot {
  /** Window-to-date spend, dollars. */
  spend: number;
  /** Window hard limit, dollars. */
  quota: number;
  /** Epoch ms. */
  windowStart: number;
  /** Epoch ms — reset time. */
  windowEnd: number;
  /** Epoch ms. Semantics: `spend` is authoritative up to this time. Real-time
   *  providers return `now`; providers with laggy reporting return
   *  `now − lagEstimate`. Drives ledger pruning. */
  asOf: number;
}

export interface ImplContext {
  /** The implementation's config block (impl-specific settings pass through untouched). */
  settings: Record<string, unknown>;
}

// =============================================================================
// Internal core types — used by quota-providers core, not exposed to impls.
// =============================================================================

export interface LedgerEntry {
  timestamp: number;
  cost: number;
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
