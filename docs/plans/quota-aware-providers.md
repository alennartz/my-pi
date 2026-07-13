# Plan: Quota-Aware Providers

## Context

Generalize the `azure-foundry` extension into a single generic **quota-providers** extension: out-of-repo provider implementations plug in through typed seams (model discovery, auth, usage), and the core adds the headline feature — pro-rated spend backpressure so a provider's billing window isn't burned early. Providers reuse pi's built-in `api` streamers only; no new protocol implementations. See [docs/brainstorms/quota-aware-providers.md](../brainstorms/quota-aware-providers.md).

## Architecture

### Impacted Modules

- **Azure Foundry** (`extensions/azure-foundry/`) — deleted. Its discovery/token/caching machinery moves into the new extension's core; its Foundry-specific logic (az CLI calls, backend resolution from deployment `format`/`capabilities`) becomes an out-of-repo implementation module maintained by the user. An in-repo *fake* implementation is kept for tests only.
- **Codemap** — the Azure Foundry module entry is replaced by the new Quota Providers module entry (cleanup phase).

### New Modules

**Quota Providers** (`extensions/quota-providers/`) — one generic extension, not foundry-branded.

- `index.ts` — extension entry: reads config, loads implementations, wires registration, enforcement, polling, and UI.
- `lib/types.ts` — the seam types (the "small lib" implementations compile against via `import type`, which is erased at runtime so out-of-repo impls have no runtime path coupling).
- `lib/core.ts` (plus supporting files) — provider registration, cache/refresh policy, quota math, ledger, bypass state. Pure functions for all computation (quota math, pruning, cache-shape parsing); file I/O concentrated at the edges.
- `runner.mjs` — generic out-of-band runner: a plain-node child process that loads an implementation module via jiti and executes one named seam function, writing the result to a core-owned cache file. Replaces per-provider helper scripts.
- Implementation discovery config: `~/.pi/agent/quota-providers.json` (see Interfaces). Implementations live **outside this repo**; the config points at their module paths.
- Cache/state files per implementation under `~/.pi/agent/cache/quota-providers/<implId>/`: `models.json` (discovery cache), `token.json` (token cache), `usage.json` (last authoritative snapshot), `ledger.jsonl` (append-only local costs since snapshot), `bypass.json` (scope-id-keyed bypass entries). All writes atomic (temp + rename); safe under concurrent pi processes — same discipline as the existing token cache.
- In-repo test fixture: a fake implementation module exercising all three seams without external services.

Responsibility split (settled in brainstorm, unchanged): **provider facts from the seam, user policy from config, math in the core.**

### Interfaces

#### Seam types (`lib/types.ts`)

```ts
import type { Api } from "@earendil-works/pi-ai";

/** Default export of an implementation module. */
interface ProviderImplementation {
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

interface ModelEntry {
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

interface TokenResult {
  token: string;
  /** Epoch ms. Core applies soft/hard refresh margins and caching. */
  expiresAt: number;
}

interface UsageSnapshot {
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

interface ImplContext {
  /** The implementation's config block (impl-specific settings pass through untouched). */
  settings: Record<string, unknown>;
}
```

Behavioral contracts:

- Core groups `ModelEntry[]` by `(api, baseUrlPath, authHeader)` and registers one pi provider per group, id `<implId>-<api>` (suffixed for uniqueness if a group splits further). Model metadata (reasoning, input, context window, maxTokens, cost, `forceAdaptiveThinking`) resolves from pi-ai's catalog via `getModel(catalogProvider, modelName)`; a miss falls back to the same conservative defaults the current extension uses.
- The provider `apiKey` is wired as `!node runner.mjs --module <implPath> --impl <id> token --cache <tokenCachePath>`. The runner self-caches with soft/hard expiry margins (refresh 5 min before expiry in the background; block within 30 s of expiry) — the existing foundry-helper token policy, now generic.
- Discovery caching keeps the current extension's policy: block-once on cold miss, detached background refresh, refresh floor ~30 s on process cold start / TTL ~1 h on `/new`//`/reload`, process sentinel via `globalThis` symbol.
- Seam functions are pure fetch logic; they must not cache, spawn, or write files. All process/caching mechanics belong to the core and runner.

#### Implementation discovery config (`~/.pi/agent/quota-providers.json`)

```jsonc
{
  "providers": {
    "azure-foundry": {
      "module": "~/providers/azure-foundry/impl.ts",  // loaded via jiti; ~ expanded
      "enabled": true,                                  // default true
      // user policy (all optional, core defaults shown):
      "bypassAllowed": true,
      "lookaheadHours": 6,
      "maxPollSeconds": 300,
      "enforceHardCap": false,
      // everything else passes through as ImplContext.settings
      "endpoint": "https://…", "resourceGroup": "…"
    }
  }
}
```

Malformed entries are dropped with a warning (extension degrades to no-op per provider, never crashes pi — same posture as the current extension's missing-env handling). Config never overrides seam-reported facts (spend/quota/window).

#### Quota math (pure core functions)

```ts
/** Effective spend = snapshot.spend + Σ ledger entries with timestamp > snapshot.asOf. */
effectiveSpend(snapshot: UsageSnapshot, ledger: LedgerEntry[]): number

/** Pro-rated line: quota × elapsedFraction(t) over [windowStart, windowEnd]. */
proratedLine(snapshot: UsageSnapshot, t: number): number

/** Soft-cap check (lookahead form): blocked ⇔ effectiveSpend > proratedLine(now + lookaheadMs).
 *  Hard-cap check (opt-in): blocked ⇔ effectiveSpend >= quota. */
evaluateQuota(snapshot, ledger, policy, now): QuotaVerdict
// QuotaVerdict: { state: "ok" | "soft-exceeded" | "hard-exceeded",
//                 daysAhead: number,   // how far ahead of budget, in days (can be negative)
//                 resetAt: number }
```

`daysAhead` is the single display number: the time offset t such that current effective spend equals the pro-rated line at now + t.

#### Ledger and polling

- On every `message_end` with an assistant message whose provider belongs to a managed implementation, append `{ timestamp, cost }` to that impl's `ledger.jsonl` (atomic append).
- Any pi process may refresh `usage.json` when it is older than `maxPollSeconds`; freshness is re-checked after acquiring a lock file to avoid stampedes. Refresh runs `getUsage` via the runner.
- On a fresh snapshot, ledger entries with `timestamp <= asOf` are pruned. Entries after `asOf` ride on top of the snapshot; slight double-counting inside the lag window is accepted — overcounting blocks early, undercounting silently burns budget, and early is the right bias for backpressure.

#### Enforcement and bypass

- Enforcement point: the `input` event only (prompt boundary). Verdict `soft-exceeded` without active bypass, or `hard-exceeded` with `enforceHardCap`, blocks the prompt.
  - Interactive session: notification explaining the block, current `daysAhead`, reset time, and (if `bypassAllowed`) the bypass command.
  - Non-interactive: the prompt fails with a distinctive error string beginning `quota soft cap exceeded` / `quota hard cap exceeded` — it bubbles up through normal agent output. Zero coupling to the subagents extension.
- Bypass is session-scoped and live-propagating: the root pi process sets env var `PI_QUOTA_SCOPE=<root session id>` if unset (children inherit it at spawn); bypass state lives in `bypass.json` keyed by scope id `{ [scopeId]: { enabledAt } }`. Every process checks the file at prompt time, so toggling in the parent reaches already-running children on their next prompt. Entries are pruned when stale (older than the quota window). Hard cap is never bypassable.

#### UI

- `/quota` command: per-provider status — spend, quota, `daysAhead`, window reset, bypass state, snapshot age. `/quota bypass [on|off]` toggles bypass for the current scope (rejected when `bypassAllowed` is false or seam absent).
- Footer/statusline indicator showing `daysAhead` for the worst-offending provider ("spending at Jul 19's budget"), visible whenever a managed provider has usage data; highlighted when soft-exceeded/bypassed.

### Technology Choices

**jiti (runtime TS loading of out-of-repo implementation modules).** The extension and `runner.mjs` load config-listed implementation modules with their own `createJiti()` instance (dependency declared in the extension's `package.json`).

- *Alternative — require plain ESM impls, native `import()`:* zero deps, but impl authors lose TypeScript, clashing with the typed-seams goal.
- *Alternative — rely on pi's loader intercepting dynamic `import()` in extensions:* undocumented behavior, could change between pi versions.
- jiti is the same mechanism pi itself uses to load extensions, is already present transitively, and makes TS impls work at arbitrary paths regardless of pi's loader internals.

Rejected earlier in brainstorm (recorded there): config-only/`models.json` generation (loses catalog metadata lookup, cold-start hook, single-writer ownership) and declarative provider descriptors (transport differences make config grow into code).
