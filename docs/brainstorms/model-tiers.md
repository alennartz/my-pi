# Brainstorm: Model Intelligence Tiers

## The Idea

Introduce a concept of *model intelligence tiers* — named abstraction levels (`cheap`, `medium`, `smart`, `frontier`) that skills and agent definitions use instead of concrete model IDs when selecting models for subagents. Motivated by token-cost optimization work on the autoflow pipeline: phase-appropriate model selection needs a stable vocabulary that survives model churn and stays configurable per machine/project.

## Key Decisions

### Fold into the `subagents` extension, not a standalone extension

Originally conceived as its own extension pulled in as a dependency by autoflow. Rejected in favor of extending `extensions/subagents/` directly, because:

- The subagents extension already owns the two integration points: the "Available Models" system-prompt injection (`index.ts:462`) and the `model` field validation/resolution path (`index.ts:659–738`).
- A standalone extension would need to intercept another extension's tool calls — cross-extension coupling with no consumer other than autoflow, which lives in the same package anyway.

### Tier names resolve at spawn time; raw model IDs keep working

The `model` field of `subagent` (and agent-definition `model` pins) accepts either:

- A tier name — resolved to the configured concrete model before existing validation runs. This is the advertised vocabulary.
- A raw model ID or `provider/id` ref — validated and resolved exactly as today. Unadvertised but supported, for when the user explicitly names a model.

Agent definitions pinning tiers (e.g. `scout` pinning `cheap`) fixes the staleness problem of hardcoded model IDs in definition files, since pins flow through the same resolution path (`agentConfig?.model ?? a.model`).

Unknown-model error messages should mention tier names as valid values.

### Replace the full model list in the system prompt with a tier table

The always-injected "Available Models" list (~16 lines per session) is removed. In its place: a four-row tier table showing each tier's currently resolved model ID — the resolved IDs stay visible so transcripts remain legible. Prompt guidance flips from "do not set a custom model unless asked" to "pick the tier matching the task; raw model IDs also work when the user names one."

### `list_models` tool for on-demand discovery

A small tool exposing the full catalog from `ctx.modelRegistry.getAvailable()`. Replaces the always-on list with pay-per-use discovery — costs nothing in the common case where tiers suffice.

### Configuration: flat JSON file, global with project override

- `~/.pi/agent/model-tiers.json` — global.
- `.pi/model-tiers.json` — project override (constructed via `CONFIG_DIR_NAME`, honored only for trusted projects).
- Shape: `{"cheap": "...", "medium": "...", "smart": "...", "frontier": "..."}`.

**Fallback:** if unconfigured, or a configured model is unavailable in the registry, the affected tier falls back to the session's default model with a one-time warning. Spawning never breaks — matters because my-pi is a package that may load on machines without the config.

### Resurrect keeps the concrete model

`resurrect` inherits the resumed session's concrete model, as today. Tiers are resolved once at spawn; resurrection does not re-resolve. Decided explicitly — a re-mapped tier changing a resurrected agent's model mid-lineage would be surprising.

## Direction

Extend `extensions/subagents/`:

1. Load tier config (global + project override) with fallback behavior.
2. Resolve tier names in the spawn path before existing `isValidModelRef` validation, covering both tool-call `model` overrides and agent-definition pins.
3. Swap the system-prompt model list for the tier table.
4. Register `list_models`.

## Open Questions

- **Follow-on topic, out of scope here:** updating autoflow, implementing, and the specialist agent definitions to speak tier vocabulary (the per-phase model table sketched during the autoflow cost review becomes tier names).
- Whether a `/tiers` command for interactive viewing/editing is worth adding later. The JSON file is the source of truth either way.
