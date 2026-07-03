# Plan: Configurable thinking effort for subagent model tiers

## Context

Let subagent model tiers (and any place that names a model for a spawned agent)
carry a thinking effort level by encoding it in pi's existing `model:<level>`
shorthand — e.g. `"smart": "anthropic/claude-opus-4-8:xhigh"`. No new config
field or `--thinking` plumbing. See
[brainstorm](../brainstorms/subagent-thinking-tiers.md) for the full exploration
and how pi represents thinking (fixed six-level vocabulary, per-model adaptive
translation, automatic clamping, and the `:level` shorthand).

## Architecture

### Impacted Modules

**Subagents** (`extensions/subagents/`) — the only module touched. Two files:

- `model-tiers.ts` — gains a pure helper that splits a trailing thinking-level
  suffix off a model pattern, and makes tier resolution + tier-table rendering
  judge model availability on the *model part* while carrying the *full*
  suffixed string through as the value passed to the child's `--model`. Tier
  config values stay plain strings — no schema change; the type
  `TierConfig = Partial<Record<TierName, string>>` is unchanged.
- `index.ts` — the spawn-tool `model` validation and the spawn-time model
  normalization become suffix-aware, so a concrete `provider/id:level` param (or
  a suffixed tier value) validates and passes through instead of being rejected
  or collapsed to the session default. The injected **Model Tiers** system-prompt
  section gains one sentence advertising the `model:<level>` shorthand and the
  six valid levels.

No change to the resurrect/fork paths: the suffixed string bakes into the child
session at spawn and is inherited verbatim (consistent with DR-038). Agent
frontmatter `model:` needs no code change — it already flows straight to
`--model`, so `model: anthropic/…:xhigh` works for free.

### Interfaces

**`stripThinkingSuffix` (new, pure, in `model-tiers.ts`)**

```ts
// The six pi thinking levels, mirrored locally for suffix validation.
const THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
function isThinkingLevel(s: string): s is ThinkingLevel;

// Split a trailing ":<valid-level>" off a model pattern, mirroring pi's
// split-on-last-colon. Only splits when the suffix is one of the six levels,
// so colon-bearing model ids (e.g. OpenRouter "openai/gpt-x:exacto") are left
// whole. Returns the model part and the level (if any).
function stripThinkingSuffix(pattern: string): { model: string; thinking?: ThinkingLevel };
//   "anthropic/claude-opus-4-8:xhigh" -> { model: "anthropic/claude-opus-4-8", thinking: "xhigh" }
//   "openai/gpt-5.4:exacto"           -> { model: "openai/gpt-5.4:exacto" }        (suffix not a level)
//   "anthropic/claude-opus-4-8"       -> { model: "anthropic/claude-opus-4-8" }
```

**`resolveModelRef(ref, tiers, isAvailable)` (existing, in `model-tiers.ts`)** —
behavior change for configured tiers whose value carries a suffix:

- Availability is judged on `stripThinkingSuffix(configured).model`, not the raw
  configured string.
- On success, the returned `model` is the **full configured string** (suffix
  intact) — that is what reaches `--model`.
- When the model part is unavailable, fall back to the session default (model
  `undefined`) with a warning that names the **model part**, not the suffixed
  string. Return shape is unchanged: `{ model: string | undefined; warning?: string }`.
- Non-tier and unconfigured-tier cases are unchanged.

**`renderTierTable(tiers, isAvailable, defaultModelRef)` (existing)** — a tier
whose model part is available renders its **full configured string** (e.g.
`` `anthropic/claude-opus-4-8:xhigh` ``) in the Model column; availability is
judged on the model part. Unavailable/unconfigured rows keep the current
`(default)` behavior. Signature unchanged (`string[]`).

**`index.ts` spawn path** — two adjustments:

- Validation: the `model`-override check accepts a value whose
  `stripThinkingSuffix(...).model` is a valid model ref (or a tier name), instead
  of requiring an exact registry match on the whole string.
- Normalization: before the `id → provider/id` rewrite, strip the suffix,
  resolve the model part against `getAvailable()`, then re-append the suffix — so
  a bare `id:level` still gets provider-disambiguated (the reason the
  normalization exists per DR-036) while the level is preserved.

### Behavioral contracts (for tests)

- A tier configured as `provider/id:<level>` with an available model resolves to
  the full `provider/id:<level>` string and renders it in the tier table.
- A tier whose model part is unavailable falls back to the session default; the
  warning mentions the model part only.
- A concrete spawn `model` param of `provider/id:<level>` passes validation and
  reaches `--model` intact.
- A model pattern with a non-level trailing colon segment (e.g. `:exacto`) is
  never split — the whole string is treated as the model ref.
- `off`, `minimal`, `low`, `medium`, `high`, `xhigh` are all recognized as valid
  suffixes; anything else is not.
