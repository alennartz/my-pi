# model-tiers

Drive a real `pi --mode rpc` to verify the subagents extension's model-tier
feature end-to-end — the live wiring in `extensions/subagents/scoped-extension.ts`
that the pure-function unit tests (`model-tiers.test.ts`) cannot reach.

## Purpose

Each check launches a fresh top-level pi under a controlled
`PI_CODING_AGENT_DIR` (a temp agent dir with its own `settings.json` that
loads this repo as a package plus a `before_provider_request` probe
extension). The probe writes the assembled provider payload to a file so the
harness can inspect the exact system prompt the model received.

Checks:

- **A injection-unconfigured** — no config: the injected system prompt has a
  `## Model Tiers` table with all four tiers showing the session-default
  model + `(default)`, and no `## Available Models` block.
- **B injection-overlay** — global `{cheap, medium}` + project `{cheap}`: the
  tier table shows the project's `cheap` (override wins), the global `medium`
  (survives), and default rows for `smart`/`frontier`.
- **C trust-independent-overlay** — project config present with the project
  untrusted: the project override is still honored (post-review user ruling:
  tier remapping is user configuration, not a trust boundary — both overlays
  are read unconditionally).
- **D spawn-configured** — tier `cheap` mapped to a real non-default model:
  spawning a subagent with `model:"cheap"` runs that model (read from the
  child's persisted session file), no unconfigured notice fires, and a raw
  model-id spawn resolves to that raw model. Folds in the **F list_models**
  check (catalog table with context-window + pricing columns).
- **E spawn-unconfigured** — no config: spawning `model:"cheap"` runs the
  session-default model AND the once-per-session "unconfigured" notice fires.

## Invocation

```
node tools/manual-test/model-tiers/run.mjs [--keep] [--timeout <sec>] [--workdir <dir>]
```

- `--keep` — do not delete the temp workdir on exit (default: delete unless
  `--workdir` was passed).
- `--timeout <sec>` — per-phase timeout (default 180).
- `--workdir <dir>` — use an explicit workdir instead of a fresh mkdtemp.
- `MT_VERBOSE=1` — echo pi stderr and tool-end events for debugging.
- `MT_PROVIDER` / `MT_MODEL` — session default provider/model (defaults:
  `azure-foundry-anthropic-messages` / `claude-opus-4-8`, the original
  harness environment).
- `MT_TIER_MODEL` / `MT_RAW_MODEL` / `MT_PROJECT_MODEL` — three real,
  available, mutually distinct non-default models used by the tier-overlay
  and spawn checks (defaults match the original azure-foundry environment).
  The tier table only renders a configured value when the model exists in the
  registry (otherwise the row shows the session default), so all three must
  be real.
- When `LLMGATEWAY_API_KEY` is set, the temp agent dir also registers this
  repo's devpass quota-provider implementation (with the spend-backpressure
  lookahead relaxed) so `MT_PROVIDER=devpass-openai-completions` works.

## Inputs / Outputs

- **Inputs:** flags only; uses ambient pi provider config (this repo's
  azure-foundry env credentials).
- **Outputs:** human-readable phase log on stderr; a JSON verdict on stdout
  `{ verdict, checks, observed }`. Exit 0 = PASS, 1 = FAIL.

## Prerequisites

`pi` on PATH with this repo loadable as a package. The harness scrubs inherited
coding-agent markers from the spawned parent environment. Tier config values
point at real, available non-default models so a resolved tier is
distinguishable from a session-default fallback.

## Use for

Any topic touching model-tier config, tier resolution on the spawn path, the
tier prompt-injection block, or the `list_models` tool. Limitations: the
spawn checks drive a real LLM to call `subagent`, so they cost tokens and
tolerate transient latency; the child's model is read from its session file
(an independent oracle), not from tool-call narration.
