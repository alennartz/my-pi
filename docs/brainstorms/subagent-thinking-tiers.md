# Brainstorm: Configurable thinking effort for subagent model tiers

## The idea

Let subagent model tiers (and, by extension, any place that names a model for a
spawned agent) carry a **thinking effort level**, not just a model id. Motivating
case: a `smart` tier pointed at an adaptive-thinking model like Claude Opus 4.8
realistically wants `xhigh` effort, but today the tier config can only name the
model — the child boots at its own default thinking level.

## Background: how pi represents thinking (investigated)

- **Thinking levels are a fixed pi vocabulary:** `off · minimal · low · medium ·
  high · xhigh` (`VALID_THINKING_LEVELS` / `ModelThinkingLevel` in pi-ai). That's
  the entire user-facing dial.
- **Adaptive thinking is a per-model provider detail, invisible to callers.** A
  model declares `compat.forceAdaptiveThinking: true` (Claude Fable 5, Opus 4.8,
  some Sonnets). That flag switches the Anthropic request to
  `thinking.type: "adaptive"` + `output_config.effort` instead of a token budget.
  Callers still just pick one of the six levels; pi/pi-ai translate it. **Our
  feature never needs to reason about adaptive thinking.**
- **pi clamps automatically.** `setThinkingLevel → clampThinkingLevel(model,
  level)`. Requesting a level a model doesn't support snaps to the nearest
  supported one. So passing any of the six levels is always safe — we never
  validate level-against-model ourselves. Each model also carries a
  `thinkingLevelMap` (e.g. Fable 5 `{off: null, xhigh: "xhigh"}` — can't disable
  thinking, intermediate levels collapse to a default; Opus 4.8 `{xhigh:
  "xhigh"}`).
- **pi's `--model` already accepts a `:<level>` shorthand** —
  `anthropic/claude-opus-4-8:xhigh`. The child's `parseModelPattern` splits the
  model from a trailing valid thinking level (split on last colon).

## Key decisions

### Encode thinking in the model string via pi's `:level` shorthand — no schema change

**Chosen.** A tier value stays a single opaque string; the level rides inside it:
`"smart": "anthropic/claude-opus-4-8:xhigh"`. The whole pair is handed to the
child's `--model` intact and pi's resolver splits it downstream.

**Why, over the alternatives considered:**
- A nested `{ model, thinking }` tier object + a new `thinking` field on agent
  frontmatter and spawn params + `--thinking` plumbing (the original proposal)
  was rejected as redundant: pi already has a first-class `model:level` syntax
  and does the model/level split, clamping, and adaptive translation. Re-encoding
  the same information as a separate axis duplicates a mechanism pi already owns.
- The shorthand reuses paths that already pass a model string straight to
  `--model`, so agent frontmatter (`model: …:xhigh`) and concrete spawn `model`
  params need *no code change at all*.

**Accepted consequence:** thinking cannot be set independently of a model. There
is no "keep the session-default model but bump thinking" knob, and you cannot
suffix a *tier name* (`smart:high` is not supported — tier names aren't real
models). A tier carries exactly the level baked into its own string. The user
explicitly confirmed this is the intended design: the tier string encodes the
model+level pair and stays atomic.

### The only real work: make the extension's model-availability checks suffix-tolerant

Two sites match a model string against the registry by exact equality, which a
`:level` suffix breaks:
1. `isValidModelRef` (spawn-time validation) — would reject a concrete
   `provider/id:xhigh` param as an unknown model.
2. The tier availability check used by `resolveModelRef` and `renderTierTable` —
   would deem a suffixed tier value "unavailable" and silently fall back to the
   session default.

Fix: before matching, split off a trailing `:<valid-level>` (mirroring pi's
own split-on-last-colon), validate the *model part* against the registry, and
preserve the full suffixed string as the value passed to `--model`. The
normalization that rewrites `id → provider/id` already leaves unmatched strings
untouched, so it passes the suffix through unharmed.

### Fallback behavior stays consistent with today

When a tier's *model part* is genuinely unavailable, fall back to the session
default (dropping the level too) with a warning that names the **model part**,
not the whole suffixed string — matching current unconfigured/unavailable
behavior.

## Direction

Teach the subagents extension to tolerate a valid `:<level>` thinking suffix on
model strings — in tier config values, concrete spawn `model` params, and
(already free) agent frontmatter `model:` — by stripping the suffix only for
registry availability/validation while passing the full string through to the
child's `--model`. No new config fields, no `--thinking` flag wiring, no
tier-name suffixing.

## Open questions

- Should the injected **Model Tiers** table / tool docs advertise the `:level`
  shorthand and the six valid levels so the spawning agent knows it can name a
  concrete `model:level`? (Leaning yes — cheap discoverability win. Decide in
  architecture.)
- Do we want a note steering adaptive models (Opus 4.8, Fable 5) toward `xhigh`
  rather than `high`, or leave that to pi's clamping? (Likely leave it —
  clamping handles correctness; a doc hint is optional.)
