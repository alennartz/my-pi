# pi 0.76→0.79 delta analysis: `extensions/azure-foundry/`

What this extension does: discovers Azure AI Foundry deployments out-of-band
(`foundry-helper.mjs`), then `registerProvider`s one provider per backend
(`anthropic-messages`, `openai-responses`, `openai-completions`) with a
hand-written `MODEL_CATALOG` supplying per-model cost / context / maxTokens /
`forceAdaptiveThinking`. Auth is a `!`-command apiKey that shells out to the
helper for a fresh Azure AD token per request.

Verdict up front: **no pi 0.76→0.79 change crashes or silently breaks this
extension.** The one genuine "Breaks" item is that pi-ai corrected upstream
model metadata that the extension hand-copies, so the local copy is now
divergent/stale — including one value (`gpt-5-pro` maxTokens) that is a real
request-rejection risk. The headline opportunity is dropping most of
`MODEL_CATALOG` in favour of pi-ai's `getModel()`.

---

## Breaks (with fix)

### B1. Stale model metadata — pi-ai corrected values the catalog hand-copies

Changelog item: *"Azure GPT-5.4/5.5 context window → 1,050,000 (0.79.1); GPT-5
Pro `maxTokens` → 128,000."* These corrections landed in
`pi-ai/dist/models.generated.js` under the `azure-openai-responses` provider.
The extension's `MODEL_CATALOG` still holds the pre-correction numbers:

| model | catalog value | pi-ai (corrected) | impact |
|---|---|---|---|
| `gpt-5.4` `contextWindow` | 272000 | **1050000** | undersells context window |
| `gpt-5.5` `contextWindow` | 272000 | **1050000** | undersells context window |
| `gpt-5-pro` `maxTokens` | **272000** | 128000 | **too high — see below** |
| `gpt-5.4-pro` `cacheRead` | 30 | 0 | cost overstated |
| `gpt-5.5-pro` `cacheRead` | 30 | 0 | cost overstated |
| `gpt-5-pro` `cacheRead` | 15 | 0 | cost overstated |

The contextWindow and cacheRead rows are cosmetic/accounting (pi clamps/derives
from these but a low contextWindow only triggers earlier compaction; cacheRead
only affects cost display).

The **`gpt-5-pro` maxTokens = 272000** row is the real one. pi feeds the
model's `maxTokens` into `max_output_tokens` on the Azure Responses request
(`buildParams` in `azure-openai-responses.js` / `openai-responses.js` sets
`params.max_output_tokens = options.maxTokens`). If a deployment named to model
`gpt-5-pro` is registered, pi can send `max_output_tokens: 272000` against a
model whose real cap is 128000 — exactly the mismatch pi-ai's 0.79.1 fix
corrects. Azure will reject that request.

**Fix (tactical):** edit the three numeric values in `MODEL_CATALOG` to match
pi-ai — `gpt-5.4`/`gpt-5.5` `contextWindow` → 1050000, `gpt-5-pro` `maxTokens`
→ 128000, and the three Pro `cacheRead` → 0.

**Fix (strategic):** stop hand-copying — see Simplification S1, which makes this
whole class of drift impossible.

---

## Simplifications (with how)

### S1. Replace most of `MODEL_CATALOG` with pi-ai `getModel()` lookups

pi-ai now ships the exact data the catalog duplicates, keyed by model id that
matches Azure's `properties.model.name` for every catalog entry checked:

- Anthropic deployments → `getModel("anthropic", modelName)`
- OpenAI deployments (both `openai-responses` and `openai-completions`
  backends — cost/context is api-agnostic) → `getModel("azure-openai-responses", modelName)`

Each returned model already carries `reasoning`, `input`, `cost`,
`contextWindow`, `maxTokens`. Critically, the `forceAdaptiveThinking` flag the
extension hand-maintains is **already present** in pi-ai's anthropic entries as
`compat: { forceAdaptiveThinking: true }` for precisely the models the extension
flags (`claude-opus-4-6`, `-4-7`, `-4-8`, `claude-sonnet-4-6`, `claude-fable-5`).
So `lookupMeta` could collapse to: look up the pi-ai model, fall back to
`DEFAULTS` on a miss, and pass through `model.compat` verbatim. The
`MODEL_CATALOG` literal and the `ModelMeta`/`ModelCost`/`forceAdaptiveThinking`
plumbing largely disappear.

**How / caveats — read before adopting:**

1. **`@earendil-works/pi-ai` is not resolvable from the extension today.**
   Verified: `require.resolve("@earendil-works/pi-ai", {paths:[extensions/azure-foundry]})`
   → `MODULE_NOT_FOUND`. pi-ai exists only nested under
   `pi-coding-agent/node_modules`, and `pi-coding-agent` does **not** re-export
   `getModel`/`MODELS`. Adopting S1 means adding `@earendil-works/pi-ai` as an
   explicit dependency (pinned to the version pi bundles, via `npm install`).
   This is the main cost.
2. **Keep the `DEFAULTS` fallback.** Dated snapshot deployments (e.g.
   `claude-opus-4-5-20251101`, `gpt-4o-2024-08-06`) have ids pi-ai also lists,
   but any unknown/custom deployment still needs the conservative default. The
   existing fallback path already handles this.
3. **`compat` is api-agnostic to pass through.** The extension only applies
   `forceAdaptiveThinking` for the anthropic backend today; pulling `model.compat`
   from pi-ai and spreading it for the anthropic backend reproduces current
   behaviour exactly, and pi-ai's openai entries carry `thinkingLevelMap` (not
   `forceAdaptiveThinking`), so nothing leaks across backends.

Net: removes ~70 lines of hand-maintained tables, kills the B1 drift class
permanently, and auto-inherits future pi-ai additions (Fable 5, Opus 4.8,
GPT-5.x, etc.) without edits.

### S2. (Optional, low value, do NOT adopt without a concrete reason)

Switching the `openai-responses` backend to pi-ai's purpose-built
`azure-openai-responses` api is *possible* but not a clear win. That api uses
the `AzureOpenAI` SDK with `api-version` + deployment-name mapping and bakes in
`store: false`. But the current `openai-responses` path already works and
already sets `store: false` (see N1), and `azure-openai-responses`'s host
normalization only recognizes `*.openai.azure.com` / `*.cognitiveservices.azure.com`
— **not** the `*.services.ai.azure.com` Foundry endpoint this extension targets
— so it would fall back to `model.baseUrl` and add `?api-version=v1`, changing
URL shape with no observed benefit. Skip.

---

## No-impact summary

- **Azure OpenAI Responses store-disable fix (0.79.1) — no impact.** The fix
  added `store: false` to the dedicated `azure-openai-responses` api. This
  extension registers its OpenAI traffic under the generic `openai-responses`
  api, whose `buildParams` *independently* sets `store: false`
  (`openai-responses.js:181`). The extension was never on the affected path and
  doesn't need the fix.
- **API key / header config resolution (0.77.0) — no impact.** The extension's
  apiKey is a `!`-prefixed command. `parseConfigValueReference` classifies any
  `!`-leading string as `type:"command"` and runs `slice(1)` as-is — `$ENV_VAR`
  interpolation only applies to non-command *templates*, so the command string
  (and any `$` in a path inside it) is safe. The legacy-env migration regex
  (`/^[A-Z_][A-Z0-9_]*$/`) does not match the `!"…` string. And request-time
  resolution goes through `resolveConfigValueOrThrow` → `…Uncached` →
  `executeCommandUncached`, i.e. **not** the process-lifetime command cache — so
  the extension's "pi re-runs the token command per request" assumption still
  holds. Token freshness is intact.
- **Session disposal aborts in-flight work (0.77.0) / SIGTERM-SIGHUP
  `session_shutdown` (0.77.0) — no impact.** The extension's only background
  work is `spawnRefreshDetached` (`az` discovery / token refresh), spawned
  `detached` + `unref()` precisely so it outlives the session. It registers no
  `session_shutdown` handler and holds no sockets/long-lived resources. Nothing
  to release; detached children are intentionally untracked.
- **`httpIdleTimeoutMs` now applies to all providers (0.78.1) — no impact.** The
  extension neither sets nor depends on it; the new universality is benign for
  its registered providers.
- **Inherited model coverage (Fable 5, Opus 4.8, MiniMax-M3, Ant Ling, NVIDIA
  NIM; thinking-off/effort fixes) — no impact as written.** These enrich pi-ai's
  catalog under native providers; they reach this extension only via S1. As
  hand-maintained, the catalog already has `claude-fable-5` and `claude-opus-4-8`
  entries, so nothing breaks.
- **All new SDK/extension API surface — no impact.** `isProjectTrusted`,
  `project_trust` event, `defaultProjectTrust`, autocomplete trigger chars,
  `areExperimentalFeaturesEnabled`, prompt-template default args, exported RPC UI
  types, asset-path helpers, `ctx.mode`, `getSystemPromptOptions`,
  `convertToPng`, exported `parseArgs`/`Args`, `--name`, OSC 8 file links,
  `--exclude-tools`, `InputEvent.streamingBehavior`, `getAllTools`
  `promptGuidelines`: this extension only registers providers and has no UI,
  tools, input handlers, or mode branching. None apply. (The helper's private
  `parseArgs` lives in the no-pi-imports `.mjs` by design and should not adopt
  the exported one.)
- **Temp extension install dir (0.78.1), SDK `createAgentSession` missing
  package.json tolerance (0.78.1), stale `./hooks` export removal (0.79.0) — no
  impact.** Unrelated to a provider-registration extension.
