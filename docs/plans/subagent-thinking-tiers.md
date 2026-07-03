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

## Tests

**Pre-test-write commit:** `8f97447b543f93c71598f63b71853330776d2cff`

### Interface Files

- `extensions/subagents/model-tiers.ts` — added `THINKING_LEVELS`, `ThinkingLevel`, `isThinkingLevel`, and `stripThinkingSuffix`; updated `resolveModelRef` and `renderTierTable` to judge availability on the model part of suffixed values and carry the full suffixed string through on success
- `extensions/subagents/index.ts` — imported `stripThinkingSuffix`; updated spawn-tool model validation to accept `provider/id:<level>` by checking the model part; updated spawn-time normalization to strip suffix before provider-disambiguation then re-append it

### Test Files

- `extensions/subagents/model-tiers.test.ts` — added `isThinkingLevel`, `stripThinkingSuffix`, `resolveModelRef — suffix-aware`, and `renderTierTable — suffix-aware` suites (21 new tests)

### Behaviors Covered

#### `isThinkingLevel`

- Recognizes all six valid thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- Rejects arbitrary strings that are not thinking levels
- Rejects the empty string
- Is case-sensitive — capitalized levels are not valid

#### `stripThinkingSuffix`

- Strips a valid thinking level suffix from a `provider/id:level` pattern, returning the model part and the level separately
- Returns the full string as model when the suffix after the last colon is not a valid level (e.g. `:exacto`)
- Returns the full string as model when there is no colon
- Handles each of the six levels correctly
- Splits on the last colon when the pattern contains multiple colons and the last segment is a valid level
- Leaves a multi-colon model id intact when the last segment is not a valid level
- Handles a bare `id:level` pattern (no provider prefix)

#### `resolveModelRef` — suffix-aware additions

- A tier configured as `provider/id:<level>` with an available model part resolves to the full suffixed string
- A tier whose model part is unavailable falls back to undefined with a warning
- The warning names the model part only, not the full suffixed string
- A non-tier ref carrying a thinking suffix passes through unchanged
- Availability is checked against the model part, not the full suffixed string
- A tier configured without a suffix still resolves as before (no regression)

#### `renderTierTable` — suffix-aware additions

- Renders the full suffixed string in the model column for a configured available tier
- Judges availability on the model part of a suffixed configured value
- Falls back to session default when the model part of a suffixed tier is unavailable
- Never renders thinking suffixes in the model column for unconfigured/unavailable tiers
