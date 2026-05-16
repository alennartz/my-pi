# Pi 0.64.0 → 0.74.0 — Findings for `azure-foundry`

Extension: `/home/alenna/repos/my-pi/extensions/azure-foundry/index.ts` (single-file provider registration).

Touch points (per inventory, verified against source):
- `pi.registerProvider(providerId, { baseUrl, apiKey, api, models[], streamSimple })` — index.ts:295–315
- `streamSimpleAnthropic`, `streamSimpleOpenAICompletions`, `streamSimpleOpenAIResponses` from `@mariozechner/pi-ai` — index.ts:131, 141, 149
- `Model<Api>` fields used: `id`, `name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens` — index.ts:301–310

No use of: session APIs, tools, `ctx.fork`/`newSession`/`switchSession`, resource loaders, TypeBox, custom events, or any prebuilt tool exports. The extension is a pure provider registration with a custom `streamSimple` router.

---

## BREAKING entries — cross-reference

### 0.65.0 — `session_switch` / `session_fork` removed, `AgentSession` replacement APIs moved
✅ Unaffected. No session listeners or replacement calls in this extension.

### 0.65.0 — `session_directory` field removed
✅ Unaffected. Not referenced.

### 0.65.0 — Unknown single-dash CLI flags now error
✅ Unaffected. Extension does not register flags.

### 0.68.0 — `Tool[]` → tool-name allowlists; prebuilt cwd-bound tool exports removed; ambient `process.cwd()` removed from resource helpers
✅ Unaffected. Extension uses no tool exports, no `DefaultResourceLoader`, no `loadProjectContextFiles` / `loadSkills`, no `BuildSystemPromptOptions`.

### 0.69.0 — TypeBox 1.x migration / `@sinclair/typebox/compiler` shim removed
✅ Unaffected. TypeBox is not imported.

### 0.69.0 — Stale `pi`/`ctx` references invalidated after session replacement
✅ Unaffected. Extension captures `pi` only at registration time (synchronously) and never holds `ctx`. Provider registration is one-shot and not session-scoped, so there is no "captured stale reference across replacement" hazard. The `deploymentMap` module-level cache and `cachedToken` are also session-agnostic.

### 0.70.0 — OSC 9;4 progress now opt-in
✅ Unaffected.

### 0.71.0 — Built-in Google Gemini CLI / Antigravity providers removed
✅ Unaffected. Extension doesn't depend on those providers.

### 0.72.0 — `compat.reasoningEffortMap` REPLACED by model-level `thinkingLevelMap`
✅ Unaffected as a hard break: the extension never sets `compat.reasoningEffortMap` or `compat` at all on any model (verified — only `id`, `name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens` are emitted at index.ts:301–310). There is no field to migrate.

⚠️ See refactor section — the extension marks many models `reasoning: true` (Claude 4.x, o3/o4, gpt-5.x) but omits any thinking-level metadata, which means pi's thinking-level cycler likely has no provider-specific values to send. Previously this would have been `compat.reasoningEffortMap`; from 0.72.0 forward it's `thinkingLevelMap`. The pre-upgrade code was already in the "no mapping declared" state, so behavior is unchanged across the upgrade, but the new API gives a cleaner way to plug this gap.

### 0.73.0 — `xiaomi` provider config break
✅ Unaffected.

### 0.74.0 — Package rename `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`
✅ Unaffected at runtime. `package.json` uses `"*"` for the peer dependency and the legacy scope is still aliased by pi. Imports in `index.ts` (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`) continue to resolve.

⚠️ See refactor section — moving `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent` for the agent-side import is cosmetic but matches the new canonical name. `@mariozechner/pi-ai` is a separate, unrenamed package and stays as-is.

---

## REFACTOR opportunities

### R1 — Add top-level `name` to each `registerProvider` call (0.71.0)
The extension currently passes the provider id as the first arg (e.g. `azure-foundry-anthropic-messages`) and no human-friendly label. 0.71.0 added a top-level `name` field for `/login` and selector display.

Before: three providers identified only by terse machine ids.
After (sketch): set `name: "Azure Foundry (Anthropic)"`, `"Azure Foundry (OpenAI Responses)"`, `"Azure Foundry (OpenAI Completions)"` so they read nicely in pi's UI. Pure additive change to the second-arg object.

### R2 — Optionally collapse three providers into one via per-model `baseUrl` overrides (0.72.0)
Today the extension registers three sibling providers (one per backend) because `baseUrl` and `api` historically had to live at the provider level. 0.72.0 added per-model `baseUrl` overrides on `pi.registerProvider()`.

`api` is still per-provider though, so collapse is only partial: backends with different `api` strings (`anthropic-messages` vs `openai-responses` vs `openai-completions`) still need separate provider registrations. The per-model `baseUrl` knob doesn't help here because the three providers are split on `api`, not on URL. **Recommendation: leave the three-provider layout alone.** The 0.72.0 feature is irrelevant unless multiple backends ever shared the same `api` string.

### R3 — Add `thinkingLevelMap` to reasoning-capable models (0.72.0)
Models registered with `reasoning: true` (Claude Sonnet/Opus/Haiku 4.x, o3 family, o4-mini, gpt-5.x) have no mapping today, which means pi's thinking-level cycle has no provider-side levers to pull. Now would be a clean moment to populate `thinkingLevelMap` per backend:
- Anthropic-format deployments: map pi's `low | medium | high` to Claude `budget_tokens` integers (or `null` to hide).
- OpenAI Responses deployments: map to OpenAI `reasoning.effort` strings (`"low" | "medium" | "high"`).
- OpenAI Completions deployments: these models generally don't accept reasoning effort over completions API — use `null` for unsupported levels so cycling skips them.

This is a refactor *opportunity* surfaced by the upgrade, not a fault — the pre-upgrade code was equivalently silent.

### R4 — Migrate import path to `@earendil-works/pi-coding-agent` (0.74.0)
One-line cosmetic change. `package.json` already uses `"*"` for the peer dep so nothing else needs to move. Low priority; legacy alias still works.

---

## Other observations (informational, not changelog-driven)

- The custom `streamSimple` router at index.ts:271 receives `Model<Api>` and forwards to the appropriate `streamSimple*` from `@mariozechner/pi-ai`. No changelog entry in the 0.64.0 → 0.74.0 window touches the signature of `streamSimpleAnthropic` / `streamSimpleOpenAICompletions` / `streamSimpleOpenAIResponses`, nor the shape of `Model`, `Context`, `SimpleStreamOptions`, or `AssistantMessageEventStream`. (Those types live in `@mariozechner/pi-ai`, which is out of scope for this changelog — if pi-ai itself has changed independently, that requires a separate audit.)
- `package.json` peer dep is `"*"` so the npm-scope rename in 0.74.0 has no resolution impact.

---

**Verdict: safe** (refactors R1, R3, R4 are optional polish; R2 doesn't apply).
