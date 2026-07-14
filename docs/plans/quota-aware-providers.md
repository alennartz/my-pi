# Plan: Quota-Aware Providers

## Context

Generalize the `azure-foundry` extension into a single generic **quota-providers** extension: out-of-repo provider implementations plug in through typed seams (model discovery, auth, usage), and the core adds the headline feature — pro-rated spend backpressure so a provider's billing window isn't burned early. Providers reuse pi's built-in `api` streamers only; no new protocol implementations. See [docs/brainstorms/quota-aware-providers.md](../brainstorms/quota-aware-providers.md).

## Architecture

### Impacted Modules

- **Azure Foundry** (`extensions/azure-foundry/`) — deleted. Its discovery/token/caching machinery moves into the new extension's core; its Foundry-specific logic (az CLI calls, backend resolution from deployment `format`/`capabilities`) becomes an out-of-repo implementation module maintained by the user. An in-repo *fake* implementation is kept for tests only.
- **Codemap** — the Azure Foundry module entry is replaced by the new Quota Providers module entry (cleanup phase).
- **Subagents** (`extensions/subagents/agent-set.ts`) — gains *generic* prompt-failure surfacing (no quota knowledge): when a child emits an error-level notify while marked running with no `agent_start` since its last prompt, the entry settles as failed with the notify text as `lastError`. Needed because pi's extension runner swallows all `input`-handler throws — an extension cannot make the RPC `prompt` command fail, so a blocked child prompt would otherwise leave the parent waiting forever. (Decided during impl planning; see Enforcement below.)

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
  - Non-interactive: the block surfaces as a distinctive error string beginning `quota soft cap exceeded` / `quota hard cap exceeded`. **Mechanism (settled during impl planning):** the `input` handler returns `{ action: "handled" }` *and* emits `ctx.ui.notify(errorString, "error")`. Throwing from the handler does NOT work — pi's extension runner catches and swallows all `input`/`before_agent_start` handler throws (`dist/core/extensions/runner.js`), so the RPC prompt command still reports success; implementers must not regress to the throw idea. In RPC mode the error notify reaches the parent's `RpcChild` event stream as an `extension_ui_request` (method `notify`, notifyType `error`); the generic subagents fix (see Impacted Modules) settles the child entry from it. The quota extension stays fully decoupled from subagents.
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

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

## Steps

**Pre-implementation commit:** `413e901d216017cb22b58c7351914cc859f16e0b`

### Step 1: Scaffold the extension and add the jiti dependency

Create `extensions/quota-providers/package.json` mirroring the other extension manifests (`name: "quota-providers"`, `pi.extensions: ["./index.ts"]`). Create an empty `extensions/quota-providers/index.ts` exporting a no-op default extension factory (`export default function (pi: ExtensionAPI) {}`) so pi loads cleanly while the module is built up.

Add `jiti` as a dependency of the repo-root `package.json` via `npm install jiti` (never hand-edit the manifest). Root is the actual pi package — pi runs `npm install` there on package install, and Node resolution from both `extensions/quota-providers/index.ts` and `runner.mjs` walks up to the root `node_modules`. Note: pi itself uses a fork (`@mariozechner/jiti`, present transitively) — we depend on upstream `jiti` explicitly rather than reaching into pi's transitive deps.

**Verify:** `node -e "require.resolve('jiti')"` succeeds from the repo root; `package.json` diff shows `jiti` under `dependencies`; extension dir exists with manifest + stub.
**Status:** done

### Step 2: Seam types (`lib/types.ts`)

Create `extensions/quota-providers/lib/types.ts` containing exactly the interfaces from the Architecture § Interfaces: `ProviderImplementation`, `ModelEntry`, `TokenResult`, `UsageSnapshot`, `ImplContext`. `Api` comes from `import type { Api } from "@earendil-works/pi-ai"`. Types only — no runtime code, so out-of-repo implementations importing it via `import type` carry no runtime path coupling. Also export the internal core types used downstream: `LedgerEntry { timestamp: number; cost: number }`, `QuotaVerdict { state: "ok" | "soft-exceeded" | "hard-exceeded"; daysAhead: number; resetAt: number }`, and `QuotaPolicy { bypassAllowed: boolean; lookaheadHours: number; maxPollSeconds: number; enforceHardCap: boolean }`.

**Verify:** file exists; contains only type/interface declarations (no value exports besides types); other steps compile against it in-editor.
**Status:** done

### Step 3: Config loading (`lib/config.ts` + tests)

Create `extensions/quota-providers/lib/config.ts` with pure parsing separated from file I/O:

- `POLICY_KEYS = ["module", "enabled", "bypassAllowed", "lookaheadHours", "maxPollSeconds", "enforceHardCap"] as const` — the reserved keys; everything else in a provider block passes through as `ImplContext.settings`.
- `parseProvidersConfig(raw: string, expandHome: (p: string) => string): { providers: ResolvedProvider[]; warnings: string[] }` — pure. `ResolvedProvider = { id, modulePath, enabled, policy: QuotaPolicy, settings: Record<string, unknown> }`. Policy defaults: `bypassAllowed: true`, `lookaheadHours: 6`, `maxPollSeconds: 300`, `enforceHardCap: false`. Malformed entries (missing/non-string `module`, non-object block, unparseable JSON) are dropped into `warnings`, never thrown — the extension must degrade to a per-provider no-op, mirroring azure-foundry's missing-env posture.
- `loadProvidersConfig(path?: string): { providers; warnings }` — thin I/O shell; default path `<agentDir>/quota-providers.json` where agentDir resolution is ported verbatim from `resolveAgentDir()` in `extensions/azure-foundry/index.ts` (honors `PI_CODING_AGENT_DIR`, `~` expansion). Missing file → empty providers, no warning.
- `cachePaths(agentDir: string, implId: string)` — pure: returns `{ dir, models, token, usage, ledger, bypass, usageLock }` under `<agentDir>/cache/quota-providers/<implId>/` (`models.json`, `token.json`, `usage.json`, `ledger.jsonl`, `bypass.json`, `usage.lock`).

Write `lib/config.test.ts` (vitest, colocated like subagents tests): defaults applied, settings passthrough excludes policy keys, `~` expansion, malformed entry dropped with warning, missing file, `enabled: false` respected.

**Verify:** `npx vitest run extensions/quota-providers/lib/config.test.ts` passes.
**Status:** done

### Step 4: Quota math (`lib/quota.ts` + tests)

Create `extensions/quota-providers/lib/quota.ts` — pure functions only, exactly the Architecture § Quota math contract:

```ts
effectiveSpend(snapshot: UsageSnapshot, ledger: LedgerEntry[]): number
proratedLine(snapshot: UsageSnapshot, t: number): number
daysAhead(snapshot: UsageSnapshot, effectiveSpend: number, now: number): number
evaluateQuota(snapshot: UsageSnapshot, ledger: LedgerEntry[], policy: QuotaPolicy, now: number): QuotaVerdict
```

- `effectiveSpend` = `snapshot.spend` + Σ ledger entries with `timestamp > snapshot.asOf`.
- `proratedLine(s, t)` = `s.quota × clamp((t − s.windowStart) / (s.windowEnd − s.windowStart), 0, 1)` (clamped so t beyond the window can't exceed quota).
- `daysAhead` = the offset t (in days, can be negative) such that effective spend equals the pro-rated line at `now + t`: `((spend / quota) × windowLength − (now − windowStart)) / DAY_MS`.
- `evaluateQuota`: `hard-exceeded` ⇔ `effectiveSpend >= quota` (reported regardless of `enforceHardCap`; whether it *blocks* is the caller's policy decision); else `soft-exceeded` ⇔ `effectiveSpend > proratedLine(now + lookaheadHours in ms)`; else `ok`. `resetAt = windowEnd`.
- Guard degenerate inputs: `quota <= 0` or `windowEnd <= windowStart` → treat as no enforcement (`ok`, `daysAhead: 0`) rather than NaN/Infinity.

Write `lib/quota.test.ts`: under-budget, exactly-on-line, lookahead boundary, negative daysAhead, ledger riding on snapshot, entries ≤ asOf ignored, hard cap, degenerate window/quota.

**Verify:** `npx vitest run extensions/quota-providers/lib/quota.test.ts` passes.
**Status:** done

### Step 5: Ledger and bypass stores (`lib/ledger.ts`, `lib/bypass.ts` + tests)

Create `extensions/quota-providers/lib/ledger.ts`:

- `parseLedger(raw: string): LedgerEntry[]` — pure; JSONL, tolerates torn/garbage trailing lines (skip, don't throw).
- `pruneLedger(entries: LedgerEntry[], asOf: number): LedgerEntry[]` — pure; keeps entries with `timestamp > asOf`.
- `appendLedgerEntry(path: string, entry: LedgerEntry): void` — I/O shell; single `appendFileSync` with `O_APPEND` semantics (one `JSON.stringify(entry) + "\n"` write — atomic enough for line-granular appends across processes), `mkdirSync` recursive on first use.
- `readLedger(path: string): LedgerEntry[]` — I/O shell over `parseLedger`; missing file → `[]`.

Create `extensions/quota-providers/lib/bypass.ts`:

- `parseBypass(raw: string): Record<string, { enabledAt: number }>` — pure, tolerant of garbage (→ `{}`).
- `pruneBypass(entries, now, windowLengthMs): Record<...>` — pure; drops entries with `enabledAt < now − windowLengthMs`.
- `readBypass(path)` / `writeBypass(path, entries)` — I/O shells; write is atomic (temp + rename, same `writeAtomic` discipline as `foundry-helper.mjs`; put a shared `writeAtomic(path, data)` in `lib/fsio.ts` and use it for every JSON state write in the extension).
- `isBypassActive(entries, scopeId): boolean`.

Tests `lib/ledger.test.ts` + `lib/bypass.test.ts`: torn-line tolerance, prune boundaries (`timestamp === asOf` pruned), round-trip through temp dirs, stale bypass pruning.

**Verify:** `npx vitest run extensions/quota-providers/lib/ledger.test.ts extensions/quota-providers/lib/bypass.test.ts` passes.
**Status:** done

### Step 6: Generic out-of-band runner (`runner.mjs`)

Create `extensions/quota-providers/runner.mjs` — plain Node, self-contained (no imports from `lib/*.ts`; it must run under bare `node`). Ports `foundry-helper.mjs` mechanics, generalized. CLI shape:

```
runner.mjs <command> --module <implPath> --impl <implId> --config <configPath> --cache <cacheFilePath>
  commands: token | refresh-token | discover | usage
```

- **Impl loading:** `createJiti(import.meta.url, { interopDefault: true })` from `jiti`; `await jiti.import(modulePath)` → default export is the `ProviderImplementation`. Build `ImplContext.settings` by reading `--config` (the quota-providers.json) and stripping the same reserved policy keys as Step 3 (duplicate the small key list in the .mjs with a comment pointing at `lib/config.ts` — the runner can't import TS).
- **`token` / `refresh-token`:** port the exact soft/hard-margin policy from `foundry-helper.mjs` `cmdToken`/`cmdRefreshToken`/`readCachedToken` (refresh 5 min before expiry via detached self-spawn of `refresh-token`; block within 30 s; stale-token fallback when the fresh fetch fails). The fetch itself is `impl.getToken(ctx)` returning `{ token, expiresAt }` instead of an `az` call. Cache shape `{ accessToken, softExpiresAt, hardExpiresAt }` at `--cache`. Token printed to stdout.
- **`discover`:** call `impl.discoverModels(ctx)`, validate it's an array, write `{ writtenAt: Date.now(), models: ModelEntry[] }` atomically to `--cache` (the impl's `models.json`).
- **`usage`:** acquire a lock file (`--cache` path + `.lock`, `O_EXCL` create with pid, treat locks older than ~60 s as stale and steal); after acquiring, re-check freshness of the usage cache against `--max-poll-seconds <n>` (extra flag) and exit 0 if fresh — this is the stampede guard; else call `impl.getUsage(ctx)`, write the `UsageSnapshot` as `{ writtenAt, snapshot }` atomically to `--cache`, then prune the sibling `ledger.jsonl` (drop lines with `timestamp <= snapshot.asOf`, rewrite atomically), release lock.
- All writes atomic (`writeAtomic` ported into the .mjs). Errors → message on stderr, exit 1 (mirrors `fail()` in foundry-helper).

**Verify:** step 7's integration tests exercise all four commands; manually, `node extensions/quota-providers/runner.mjs token --module <fake> --impl fake --config <cfg> --cache /tmp/t.json` prints a token.
**Status:** done

### Step 7: Fake implementation fixture + runner integration tests

Create `extensions/quota-providers/test/fake-impl.ts` — the in-repo test-only implementation exercising all three seams with no external services. Default-export a `ProviderImplementation` (`id: "fake"`, `baseUrl: "https://fake.example.com"`) whose seam functions read behavior from `ctx.settings` (e.g. `settings.models` array echoed as `ModelEntry[]`, `settings.tokenTtlMs`, `settings.usage` echoed as the `UsageSnapshot`, and a `settings.failSeams` list to force errors). It must be TS (loaded via jiti — that's part of what's under test) and import only `import type` from `../lib/types.ts`.

Create `extensions/quota-providers/runner.test.ts` — integration tests spawning `runner.mjs` with `process.execPath` against the fake impl and a temp agent dir:

- `discover` writes `models.json` with `writtenAt` + the fake's models.
- `token` cold miss blocks and writes cache; second call inside soft margin returns cached token without re-invoking the seam (fake counts invocations via a side-channel file in settings-specified temp dir); hard-expired cache blocks and refreshes.
- `usage` writes snapshot, prunes ledger entries `<= asOf`, leaves later entries; second immediate `usage` run exits without rewriting (freshness re-check under lock); stale lock is stolen.
- Failing seam → non-zero exit, stderr message, no cache corruption.

**Verify:** `npx vitest run extensions/quota-providers/runner.test.ts` passes.
**Status:** not started

### Step 8: Discovery cache + provider registration core (`lib/registration.ts` + tests)

Create `extensions/quota-providers/lib/registration.ts`:

- `readModelsCache(path: string): { writtenAt: number; models: ModelEntry[] } | null` — pure-ish read mirroring `readDeploymentsCache` (torn/garbage → null).
- `groupModels(models: ModelEntry[]): ProviderGroup[]` — pure. Groups by `(api, baseUrlPath ?? "", authHeader ?? impl default)`; each group becomes one pi provider with id `<implId>-<api>`, suffixed `-2`, `-3`… when the same api splits across baseUrlPath/authHeader. `ProviderGroup = { providerId, api, baseUrlPath, authHeader, models: ModelEntry[] }`.
- `resolveModelMeta(catalogProvider: string | undefined, modelName: string): ModelMeta` — pure wrapper over `getModel` from `@earendil-works/pi-ai/compat`; port `lookupMeta` + `DEFAULTS` + `ZERO_COST` from `extensions/azure-foundry/index.ts` unchanged (miss or absent `catalogProvider` → conservative defaults; carry `forceAdaptiveThinking` through `compat`).
- `buildProviderConfig(impl: {id; name?; baseUrl; authHeader?}, group: ProviderGroup, apiKeyCommand: string)` — pure: returns the exact object for `pi.registerProvider(group.providerId, …)` — `baseUrl: impl.baseUrl + (group.baseUrlPath ?? "")`, `apiKey: apiKeyCommand`, `authHeader`, `api`, and `models` mapped through `resolveModelMeta` (including the `compat.forceAdaptiveThinking` conditional).
- Refresh policy helpers (pure): `discoveryRefreshDue(writtenAt, now, firstRunInProcess)` with `REFRESH_FLOOR_MS = 30_000` / `REFRESH_TTL_MS = 3_600_000` ported from azure-foundry.

Write `lib/registration.test.ts`: grouping/suffixing, per-model `authHeader` override, catalog hit vs miss defaults, baseUrl assembly, refresh-due matrix.

**Verify:** `npx vitest run extensions/quota-providers/lib/registration.test.ts` passes.
**Status:** done

### Step 9: Extension entry — config, discovery, registration wiring (`index.ts`)

Flesh out `extensions/quota-providers/index.ts` (replacing the Step 1 stub), porting the azure-foundry factory flow per enabled provider from the config:

- Process sentinel: `Symbol.for("quota-providers/process-seen")` on `globalThis` (same cold-start-vs-`/reload` trick, same rationale comment).
- Per impl: read `models.json`; cold miss → block-once `execFileSync(process.execPath, [runnerPath, "discover", …])` with ~35 s timeout (skip provider with `console.warn` on failure); warm → detached background `discover` per `discoveryRefreshDue`. `runnerPath` via `fileURLToPath(new URL("./runner.mjs", import.meta.url))`; runtime is `process.execPath` (NODE_BIN rationale carries over).
- Register each `ProviderGroup` via `pi.registerProvider` with `buildProviderConfig`. The apiKey command string (quoted for `/bin/sh -c`, like azure-foundry's `tokenCommand`): `!"${process.execPath}" "${runnerPath}" token --module "…" --impl "…" --config "…" --cache "…"`.
- Config warnings surfaced once via `console.warn` (factory runs before UI exists).
- Keep a module-level immutable array of loaded provider runtime records `{ impl meta, policy, paths, hasUsageSeam }` built once in the factory — this is init-then-freeze config state consumed by Steps 10–13.
- Scope id: in a `session_start` handler, if `process.env.PI_QUOTA_SCOPE` is unset, set it to `ctx.sessionManager.getSessionId()` (children spawned by subagents inherit `process.env`, so the root session id becomes the shared scope).

**Verify:** with a config pointing at the fake impl, `pi --list-models` (or launching pi) lists the fake models under provider id `fake-<api>`; with no config file, pi starts clean with no warnings; with a malformed block, pi starts and warns.
**Status:** not started

### Step 10: Ledger appends and usage polling wiring (`index.ts`)

Still in `index.ts`:

- `message_end` handler: for assistant messages (`event.message.role === "assistant"`) whose `message.provider` matches a managed provider id (prefix match against the registered `<implId>-…` ids — build a providerId→implId map at registration time), append `{ timestamp: message.timestamp, cost: message.usage.cost.total }` to that impl's `ledger.jsonl` via `appendLedgerEntry`. Skip zero-cost messages? No — append regardless; math is unaffected and it keeps the rule simple.
- Staleness-driven polling: a `maybeRefreshUsage(implRecord)` function — if the impl has `getUsage` and `usage.json` is missing or older than `policy.maxPollSeconds`, spawn the runner `usage` command detached (fire-and-forget, `unref()`, same pattern as `spawnRefreshDetached`). Call it from the `input` handler (before verdict evaluation, Step 11) and from the `message_end` handler. The runner's lock + freshness re-check (Step 6) makes concurrent calls from parallel pi processes safe.
- `readUsageSnapshot(path): UsageSnapshot | null` helper (torn/garbage → null) lives in `lib/` next to the other cache readers.

**Verify:** run pi against the fake impl, send a prompt on a fake model; `ledger.jsonl` gains a line with the message cost; `usage.json` appears within one poll interval; a second concurrent pi process doesn't corrupt either file.
**Status:** not started

### Step 11: Prompt-boundary enforcement (`lib/enforce.ts` + `index.ts` input handler + tests)

Create `extensions/quota-providers/lib/enforce.ts` with the pure decision function:

```ts
decideBlock(args: {
  verdict: QuotaVerdict; policy: QuotaPolicy; bypassActive: boolean;
}): { blocked: false } | { blocked: true; kind: "soft" | "hard"; message: string }
```

- `hard-exceeded` + `policy.enforceHardCap` → blocked, kind `hard`, message beginning exactly `quota hard cap exceeded` (never bypassable).
- `soft-exceeded` + no active bypass → blocked, kind `soft`, message beginning exactly `quota soft cap exceeded`; message includes `daysAhead` (rendered as a date, e.g. "spending at Jul 19's budget"), reset time, and — when `policy.bypassAllowed` — the `/quota bypass on` hint.
- Everything else → not blocked. Bypass never applies to hard.

`index.ts` `input` handler (runs for every prompt):

- Skip enforcement entirely for extension commands (`event.text.startsWith("/")` → `continue`) so `/quota bypass on` is reachable while blocked.
- Only enforce when `ctx.model` belongs to a managed provider (providerId→implId map) whose impl has the usage seam; otherwise `continue`.
- Compute verdict from the cached `usage.json` + current ledger (`evaluateQuota`); no snapshot yet → `continue` (never block on missing data); call `maybeRefreshUsage` regardless.
- Bypass check: `isBypassActive(readBypass(paths.bypass), process.env.PI_QUOTA_SCOPE ?? "")`.
- On block: **return `{ action: "handled" }`** and emit `ctx.ui.notify(message, "error")` (guarded by `ctx.hasUI`; in print/JSON mode fall back to `console.error`). Interactive vs non-interactive share the same path — the notify carries the explanation in the TUI and becomes the parent-visible `extension_ui_request` in RPC mode. **Do NOT throw — pi's extension runner swallows `input`-handler throws and the prompt would sail through** (see Architecture § Enforcement).

Write `lib/enforce.test.ts`: the decideBlock matrix (soft/hard × bypass × enforceHardCap × bypassAllowed), exact error-string prefixes, message content (daysAhead date, reset, hint presence).

**Verify:** `npx vitest run extensions/quota-providers/lib/enforce.test.ts` passes; manually, with the fake impl reporting over-line usage, an interactive prompt is refused with the notification and no LLM call occurs.
**Status:** not started

### Step 12: `/quota` command (`index.ts`)

`pi.registerCommand("quota", …)` in `index.ts`:

- No args: per managed provider render spend, quota, `daysAhead` (both raw and "spending at <date>'s budget"), window reset time, snapshot age (from `usage.json` `writtenAt`; "no data yet" when absent), bypass state for the current scope, and whether the impl has the usage seam. Output via `ctx.ui.notify` or a custom message — match how other extensions in this repo present command output (worktree is the reference).
- `bypass on` / `bypass off` (also bare `bypass` = toggle): rejected with an explanatory notify when `bypassAllowed` is false for every managed provider or no provider has the usage seam; otherwise read-modify-write `bypass.json` for `process.env.PI_QUOTA_SCOPE` (set `{ enabledAt: Date.now() }` / delete the key), pruning stale entries (`pruneBypass` with the current snapshot's window length; fall back to 30 days when no snapshot) in the same write.

**Verify:** `/quota` shows the fake provider's numbers; `/quota bypass on` then a previously-blocked prompt goes through; `bypass off` restores blocking; a second pi process sharing the scope id observes the toggle at its next prompt.
**Status:** not started

### Step 13: Footer indicator (`index.ts`)

Statusline via `ctx.ui.setStatus("quota-providers", text)` (guarded by `ctx.hasUI`):

- Text shows the worst-offending provider's position: `quota: spending at <date>'s budget` where `<date>` = now + daysAhead (the same single display number from `evaluateQuota`), suffixed ` (soft cap)` when soft-exceeded and ` (bypassed)` when bypassed, ` (HARD CAP)` when hard-exceeded.
- Visible whenever at least one managed provider has a usage snapshot; cleared (`setStatus("quota-providers", undefined)`) otherwise.
- Recompute + update wherever the verdict is already computed: after the `input` handler evaluation, after each `message_end` ledger append, and on `session_start`. Extract a single `refreshStatusline(ctx)` helper so all three paths share one code path (one business operation, one function).

**Verify:** running pi with the fake impl shows the footer status; pushing fake usage past the line flips it to the soft-cap variant; `/quota bypass on` flips it to bypassed.
**Status:** not started

### Step 14: Generic subagents fix — settle children blocked before agent_start

In `extensions/subagents/agent-set.ts` (keep it quota-agnostic — the code must not mention quota):

- Track per entry `agentStartedSinceLastPrompt: boolean` — set false when the initial `Task:` prompt is sent (around line 405) and whenever the parent re-prompts the child; set true on the child's `agent_start` event (the handler around line 716).
- In the child-event handler, add a branch for `event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error"`: if `entry.status.state === "running"` and `!agentStartedSinceLastPrompt`, settle the entry exactly like the `agent_end` error path (lines ~723–750): `state = "failed"`, `lastError = event.message`, `lastActivity = undefined`, `broker?.agentIdled(entry.id)`, `onUpdate`, `completionNotified = true`, `onAgentComplete(...)`. If the entry is *not* running (idle child received a blocked broker-delivered message), still call `broker?.agentIdled(entry.id)` so pending blocking sends fail fast with the existing "went idle without responding" error instead of hanging.
- Extract the settle-as-failed block shared with the `agent_end` error path into one private method (`settleFailed(entry, errorMessage)`) rather than duplicating it — same business operation, one function.

Add a test next to the existing agent-set coverage (follow the pattern of `broker.test.ts`/`messages.test.ts`; if `agent-set` has no test file yet, create `extensions/subagents/agent-set.test.ts` exercising `handleEvent` with synthetic events): error-notify before agent_start settles the entry as failed with lastError; error-notify *after* agent_start is ignored (agents may legitimately notify errors mid-run); error-notify to an idle entry unblocks pending sends.

**Verify:** `npx vitest run extensions/subagents` passes including the new test; manually, a child spawned with the fake impl in a blocked state fails fast with `lastError` starting `quota soft cap exceeded` instead of hanging `await_agents`.
**Status:** done

### Step 15: End-to-end pass with the fake implementation

Wire a real `~/.pi/agent/quota-providers.json` (or a temp agent dir via `PI_CODING_AGENT_DIR`) pointing at `extensions/quota-providers/test/fake-impl.ts` and walk the full loop in a live pi: models registered and selectable, token flows through the runner on a request, ledger accrues, usage polls, footer shows, soft-cap block fires at the prompt boundary, `/quota` + bypass work, a subagent blocked at spawn settles as failed with the distinctive error. Fix integration seams this shakes out (this step exists because Steps 9–14 each verify in isolation; this is the assembled system).

**Verify:** every behavior in the list above observed in one session; no regressions in `npx vitest run`.
**Status:** not started

### Step 16: Delete the azure-foundry extension

Remove `extensions/azure-foundry/` entirely (index.ts, foundry-helper.mjs, package.json). Its machinery now lives in quota-providers (`runner.mjs`, `lib/registration.ts`); its Foundry-specific logic (az CLI calls, `resolveBackend` from deployment format/capabilities) is the user's out-of-repo implementation module, deliberately not part of this repo. Do not port it here. Leave the codemap's Azure Foundry entry for the cleanup phase (per Architecture § Impacted Modules).

**Verify:** `extensions/azure-foundry/` no longer exists; `rg -l azure-foundry extensions/` returns nothing (references in docs/plans/brainstorms are fine); pi starts cleanly without the extension.
**Status:** not started
