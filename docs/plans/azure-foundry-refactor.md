# Azure Foundry extension refactor — kill the api-hijack bug and the startup stall

> **Status: implemented.** `extensions/azure-foundry/index.ts` rewritten; new
> `extensions/azure-foundry/foundry-helper.mjs` added. Local no-`az` smoke tests pass
> (helper syntax, arg/env validation, token cache-hit, atomic nested-dir write). Live
> verification (header parity, routing isolation, startup latency) must run on the
> Foundry+Copilot machine — see Verification.


Two confirmed problems in `extensions/azure-foundry/index.ts`, fixed by one coordinated
refactor. Both fixes share the same move: get synchronous `az` CLI work off the extension
factory path and stop using a custom `streamSimple`.

Related: `docs/investigations/upstream-custom-provider-api-routing.md` (the upstream bug this
sidesteps).

---

## Problem A — custom `streamSimple` hijacks all traffic for its `api`

pi dispatches streaming by `model.api`, and the api→handler registry holds **one** handler
per api (`api-registry.js`: `apiProviderRegistry.set(provider.api, …)`; `stream.js`:
`resolveApiProvider(model.api).streamSimple(…)`). Registering a custom `streamSimple` for
`anthropic-messages` overwrites the global handler, so **every** `anthropic-messages` model
(Copilot, built-in Anthropic, Bedrock) is routed through `streamAzureFoundry`.

Symptoms:
- Selecting a Copilot Claude model in `/model` and sending → `azure-foundry: unknown
  deployment "<id>"` (foreign model has no Foundry deployment).
- Subagents on a Claude model "sit idle forever" — the hijacked handler calls
  `getAzureToken()` → blocking `execSync("az …")`, which wedges the RPC child's event loop
  when `az` hangs.

## Problem B — blocking `az` in the factory stalls startup and `/new`

The `export default function(pi)` calls `discoverDeployments()` →
`execSync("az cognitiveservices account deployment list …", { timeout: 30_000 })`
**synchronously in the factory body**. pi re-runs every extension factory on cold start,
`/new`, `/reload`, resume, and fork (all via `createRuntime` → `createAgentSessionServices`
→ resource loader → `factory(api)`). So each of those blocks the event loop on `az` up to
30 s. The `spawnSync /bin/sh ETIMEDOUT` warning is this call timing out (`execSync` runs via
`/bin/sh -c`), after which registration is skipped and all Foundry models vanish for that
boot.

The loader uses `createJiti(…, { moduleCache: false })`, so the module is **re-imported
fresh** every reload — module-level `cachedToken` / `deploymentMap` are wiped each time.
In-memory memoization cannot survive `/new`; persistence must be on disk.

### Behavior today, explicitly

| Event | Today |
|---|---|
| Cold start | blocks on discovery (≤30 s); registers or skips on timeout |
| `/new` | re-runs factory → blocks on discovery again |
| `/reload` | re-runs factory → blocks on discovery again |
| resume / fork | re-runs factory → blocks on discovery again |
| First Azure model use | blocks once on `az get-access-token` (≤15 s), cached until next reload wipes it |

---

## Target design

### Axis 1 — routing: drop `streamSimple`, register as a normal provider

Register each backend provider with a static config and let pi's **built-in** streamer route
by provider (provider-aware: it uses `model.baseUrl` and resolves auth by `model.provider`).
No custom streamer ⇒ the api-hijack bug structurally cannot occur, and the wedged-subagent
failure mode disappears.

Per-backend registration (verified for header parity against the built-in streamers):

| Provider | api | `apiKey` | `authHeader` | Resulting auth |
|---|---|---|---|---|
| `azure-foundry-anthropic-messages` | `anthropic-messages` | `!<token-helper …>` | **`true`** | core adds `Authorization: Bearer <token>`; SDK also sends `x-api-key: <token>` (Azure ignores it) |
| `azure-foundry-openai-responses` | `openai-responses` | `!<token-helper …>` | unset | OpenAI SDK sends `Authorization: Bearer <token>` natively |
| `azure-foundry-openai-completions` | `openai-completions` | `!<token-helper …>` | unset | same as responses |

`authHeader: true` is set **only** on the anthropic provider (matches today's per-backend
split where only anthropic injected an `Authorization` header).

**Parity verified in source:**
- `anthropic.js` default path: `new Anthropic({ apiKey, defaultHeaders: mergeHeaders(defaults,
  …, optionsHeaders) })` — `optionsHeaders` carries the `Authorization` core injects; SDK
  adds `x-api-key` from `apiKey`. Both headers sent — same shape as today, the only change
  being `x-api-key` now holds the real token instead of the literal `"azure-foundry"`.
- `openai-responses.js` / `openai-completions.js`: `new OpenAI({ apiKey, baseURL,
  defaultHeaders })` → native `Authorization: Bearer <apiKey>`; `optionsHeaders` merge last.

**Residual risk (live-validate only):** the anthropic request carries the real token in
`x-api-key` rather than a dummy. Azure ignores `x-api-key` today (the dummy works), so this is
structurally equivalent and not a secret leak (same endpoint, token already in
`Authorization`). Only a live request on the Foundry machine fully confirms Azure keeps
ignoring `x-api-key`. Low risk; see Verification.

### Axis 2 — latency: cache discovery, never block the factory

- **Factory reads `deployments.json` synchronously** (fast file read) and registers
  immediately.
- **Cold-start cache miss:** block **once** on discovery via `execFileSync("az", [...])`
  (no shell → no `/bin/sh`, no injection via the subscription string), write the cache,
  register. Decision locked: blocking once on first-ever boot is acceptable; it guarantees
  the saved/default model resolves at session creation.
- **Warm cache (the common path):** register from cache, then **maybe** spawn a **detached,
  non-blocking** `execFile("az", [...])` refresh that **only rewrites the cache** for the
  next factory run. It does **not** re-register a live runtime.
- **No mid-session re-registration.** The factory is the only thing that ever registers —
  exactly like today — it just sources data from cache. New deployments are picked up at the
  next rebuild (next `/new`/`/reload`/restart), which already re-registers. Staleness
  self-heals within one reload cycle.

#### When does the background refresh fire? (process cold start vs `/new`)

Locked behavior:
- **New pi process (cold start):** **always** trigger the background refresh (regardless of
  TTL). Cache empty → block once instead.
- **`/new` / `/reload` within an existing process:** **TTL-gated** — only refresh if
  `deployments.json` is older than the TTL, so we don't spawn `az` on every `/new`.

The factory cannot distinguish these via module state (`moduleCache:false` wipes module
scope on every re-import). Use a **`globalThis` sentinel** that survives across re-imports
within one process but is fresh in every new process:

```
const KEY = Symbol.for("azure-foundry/process-seen");
const firstRunInProcess = !(globalThis as any)[KEY];
(globalThis as any)[KEY] = true;
// firstRunInProcess === true  → cold start → always refresh (or block once on empty cache)
// firstRunInProcess === false → /new or /reload → TTL-gated refresh
```

**Open consideration — subagent/process storm.** "Many pi processes is the norm." Every new
process (incl. every subagent RPC child and `pi -p` one-shot) would, by the rule above,
spawn a background `az ... deployment list`. It's detached and non-blocking so it never
wedges the child, but it is N `az` invocations for N processes. Mitigation options to decide
at implementation: (a) accept it (simplest, matches the stated rule); (b) apply a short
refresh **floor** even on cold start (e.g. skip if cache written < ~30 s ago) to absorb
bursts while staying "effectively always" for interactive use; (c) suppress the cold-start
refresh when running inside a coding-agent subprocess (detectable via `PI_CODING_AGENT`).
Default lean: **(b)** a short floor — honors "new process refreshes" for humans, prevents a
thundering herd from rapid subagent spawns.

**Decision: (b) short floor** — cold start always refreshes, but skips if `deployments.json`
was written < ~30 s ago.

### Token helper (replaces module-level `cachedToken` + `streamSimple`)

A small self-caching token provider invoked by pi as the `!command` apiKey. **Runtime: Node**
(`!node <helper> --cache <abs>`) — portable across machines and reuses the existing
`expiresOn` parsing and the 5-min soft / 30-s hard refresh margins. pi's `!command`
apiKey path is **uncached** (`resolveConfigValueOrThrow` → `resolveConfigValueUncached`), so
the helper must cache itself:

- Reads `token.json`; if `accessToken` is still valid (with an early-refresh margin), prints
  it and exits — fast, no `az`.
- Otherwise runs `az account get-access-token --resource https://cognitiveservices.azure.com
  -o json`, writes `token.json`, prints the token.

This moves token fetching out of the stream path entirely (no event-loop block in
`streamSimple`, which no longer exists) and survives `/new` (on disk, unlike the wiped
module cache).

### Cache layout

```
~/.pi/agent/cache/azure-foundry/
  ├── token.json         # { accessToken, expiresAt }
  └── deployments.json   # discovery cache
```

`getAgentDir()` = `$PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent`. The extension
resolves the cache dir the same way and **bakes the absolute path into the registered
command** (e.g. `apiKey: "!<helper> --cache <abs>/token.json"`) so the extension and the
helper always agree, even under a `PI_CODING_AGENT_DIR` override.

---

## What gets deleted / changed

- **Delete** `streamAzureFoundry` and the `streamSimple` registration. `BACKENDS[*].streamFn`
  / `buildHeaders` / `apiKeyValue` are no longer needed for dispatch (kept only if useful for
  the registration table; otherwise removed).
- **Delete** the module-level `cachedToken` + `getAzureToken()` from the hot path; token
  logic moves into the helper. (`getAzureToken` may be repurposed *inside* the helper.)
- **Replace** the synchronous `discoverDeployments` call in the factory with: read cache →
  register → (cold miss) block once / (warm) background refresh.
- **Switch** `execSync(commandString)` → `execFileSync("az", [...])` / async `execFile` for
  both discovery and token fetch.
- **Add** the token-helper script (location TBD during implementation — likely shipped in the
  extension dir and invoked via `!node <helper>` or `!sh <helper>`).

---

## Cold start / `/new` / `/reload` / first-use — after the refactor

| Event | After |
|---|---|
| Cold start, cache warm | fast: file read + register; detached refresh in background |
| Cold start, cache empty | blocks once on `execFileSync` discovery, writes cache, registers |
| `/new`, `/reload` | fast: file read + register (no `az` on the factory path) |
| First Azure model use | helper runs; token cache hit → instant; miss → one `az` call, then cached on disk |
| Copilot / built-in Claude model | routed by built-in streamer — **never** touches Foundry code |

---

## Verification

1. **Header parity (live, on the Foundry+Copilot machine):**
   - Send to a Foundry anthropic model → succeeds (confirms `authHeader:true` + real-token
     `x-api-key` is accepted; closes the residual risk).
   - Send to a Foundry OpenAI-responses and OpenAI-completions model → succeeds.
2. **Routing isolation:** `/model` → Copilot Claude → send → streams via Copilot, **no**
   `azure-foundry:` error. Spawn a subagent on a Copilot Claude model → no idle hang.
3. **Startup latency:** cold start with warm cache, `/new`, `/reload` → no multi-second stall,
   no `az` in the factory path (verify by tracing / timing). Cache-empty cold start blocks
   exactly once.
4. **Cache correctness:** `token.json` reused across `/new` (no repeated `az get-access-token`);
   `deployments.json` written by background refresh and picked up on next rebuild.
5. **Degradation:** `az` not logged in / missing env vars → extension still degrades to a
   no-op without crashing pi, and without a 30 s stall (background refresh failure is silent;
   cold-miss failure surfaces a warning and skips registration as today).

---

## Implementation notes (as built)

- Token-helper: **Node** `.mjs`, two subcommands (`token`, `refresh-deployments`), self-caching
  token with the original 5-min soft / 30-s hard margins. Atomic writes (temp + `rename`).
- Storm mitigation: **(b) short floor** — `REFRESH_FLOOR_MS = 30s` on cold start,
  `REFRESH_TTL_MS = 1h` for `/new`/`/reload`, gated by a `globalThis` sentinel.
- Runtime binary: invoked via **`process.execPath`** (not bare `node`) at all three call sites
  (sync cold-miss refresh, detached background refresh, and the `!command` token apiKey), so
  it works even when pi runs as a bundled binary with `node` off PATH. Both node and bun can
  execute the `.mjs`.
- All `az` calls use `execFileSync("az", [...])` (no shell) in the helper.
- `authHeader: true` on the anthropic provider only; OpenAI providers rely on native SDK
  Bearer.

## Remaining (live-only)

- Run the Verification checklist on the Foundry+Copilot machine — especially the anthropic
  `x-api-key`-carries-real-token residual and the routing-isolation checks.
