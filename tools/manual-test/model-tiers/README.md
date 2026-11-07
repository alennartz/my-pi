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

- **A injection-unconfigured** — no config: the prompt contains the static
  `## Model Tiers` guidance table with all four tiers and no `## Available
  Models` block.
- **B injection-overlay** — global `{cheap, medium}` + project `{cheap}`:
  prompt guidance stays static and does not leak configured model IDs. The
  overlay is exercised by the configured spawn check.
- **C trust-independent-overlay** — an untrusted project overlay does not
  alter the prompt guidance. The overlay is exercised by the configured spawn
  check, where project `cheap` overrides global `cheap`.
- **D spawn-configured** — project `cheap` overrides global `cheap`; child
  session files prove the concrete tier model and raw model before any parent
  teardown. No unconfigured notice fires. Folds in **F list_models** (catalog
  table with context-window and pricing columns).
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
  `llmgateway` / `claude-opus-4-8`).
- `MT_TIER_MODEL` / `MT_RAW_MODEL` / `MT_PROJECT_MODEL` — three real,
  available, mutually distinct non-default models used by the overlay and
  spawn checks. Configured values are verified from child session files, not
  from the static prompt guidance table, so all three must be real.
- When `LLMGATEWAY_API_KEY` is set, the temp agent dir also registers this
  repo's DevPass quota source for `llmgateway` (with the spend-backpressure
  lookahead relaxed).

## Inputs / Outputs

- **Inputs:** flags and `MT_*` environment variables; the default provider
  uses `LLMGATEWAY_API_KEY`.
- **Deterministic helper tests:** `node --test tools/manual-test/model-tiers/run.test.mjs`.
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
