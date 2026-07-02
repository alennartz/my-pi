# Manual Testing — model-tiers

## Smoke Suite

The persistent `PLAN.md` journeys exercised this run:

- **J1 (subagent lifecycle — spawn, message, teardown):** touched indirectly.
  The tier feature lives on the spawn path, so the configured/unconfigured
  spawn tests re-exercise J1's spawn leg with a live `pi --mode rpc` parent.

J2/J3/J4/J5/J6 are out of scope for this topic (no changes to resurrect,
fork, workflow phases, worktrees, or resume-restore). Not re-run this run.

## Topic-Specific Tests

Model tiers add tier-named model selection to the subagents extension. The
pure resolution functions are covered by `model-tiers.test.ts` (236/236);
this run exercises the **live wiring** in `index.ts` that unit tests cannot
reach — the actual prompt injection, spawn-path resolution against the real
registry, the `list_models` tool, config-file overlay, and the once-per-
session notice. Priority checks (from the phase focus hints):

1. **Prompt injection** — a fresh session's injected system prompt contains
   the `## Model Tiers` table and no longer contains `## Available Models`.
2. **Tier spawn resolution** — spawning a subagent with `model: "cheap"`
   runs the configured model (or the session default when unconfigured).
3. **`list_models` catalog** — the tool returns a table with context-window
   and pricing columns.
4. **Config overlay** — a global `~/.pi/agent/model-tiers.json` and a project
   `.pi/model-tiers.json`, with project keys overriding global keys and
   unshadowed global keys surviving. Verified against a temp agent dir, not
   the real global config.
5. **Unconfigured notice** — the once-per-session "model tiers unconfigured"
   notice fires when no config exists and a tier name is spawned.

Adjacent-flow additions (one ring out from the hints):

6. **Raw model ID passthrough** — a raw model id in the `model` field still
   resolves and runs, unchanged from pre-tier behavior.
7. **Untrusted project gating** — project `.pi/model-tiers.json` is ignored
   when the project is not trusted (config leaks are a capability concern).

## Tools

- Reused: temp-agent-dir + `pi --mode rpc` driver pattern established by
  `tools/manual-test/resume-restore/run.mjs` (PI_PARENT_LINK scrubbing,
  JSONL framing, persistence path derivation).
- New: `tools/manual-test/model-tiers/run.mjs` — drives a real
  `pi --mode rpc` under a controlled `PI_CODING_AGENT_DIR`, captures the
  assembled provider payload via a `before_provider_request` probe extension
  (for prompt-injection and overlay checks), and drives live tier/raw spawns
  and `list_models` for the resolution and catalog checks.

## Harness Limitations

- The prompt-injection and overlay checks read the **assembled provider
  payload** (`before_provider_request` `event.payload.system`) — the exact
  string sent to the model — so they are faithful, not synthetic.
- The spawn-resolution checks drive a **real LLM** to call the `subagent`
  tool, so they cost tokens and tolerate transient latency; the child's
  actual model is read from its persisted session file (an independent
  oracle), not from tool-call narration.
- Tier config values point at **real, available** non-default models
  (`gpt-5.4-nano`, `gpt-5.4-mini`, `genitsec-haiku-4-5`) so a resolved tier
  is distinguishable from a session-default fallback.
- The once-per-session notice is observed via the RPC `extension_ui_request`
  `notify` channel — the same fire-and-forget path a real UI receives.
- None of the topic's primary behavior is behind a stub, so no escalation is
  warranted on harness grounds.

## Results

Populated after execution.

## Plan Updates

Populated after execution.

## Open Issues

Populated after execution.
