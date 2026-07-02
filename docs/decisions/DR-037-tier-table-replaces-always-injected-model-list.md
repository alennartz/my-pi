# DR-037: Tier table replaces the always-injected model list, with `list_models` for on-demand discovery

## Status
Accepted

## Context
Before model tiers, the subagents extension injected a full "Available Models" list (~16 lines) into every session's system prompt so the orchestrating agent knew what it could pass to a subagent's `model` field. With tier names becoming the advertised vocabulary, that list was both redundant for the common case and a standing token cost paid on every session regardless of whether any subagent was ever spawned with a custom model.

## Decision
Remove the always-injected "Available Models" block and replace it with a four-row "Model Tiers" table showing each tier's currently resolved concrete model id. Add a `list_models` tool that renders the full catalog (provider/id, context window, pricing) on demand, for the rarer case where a concrete model must be named explicitly.

The tier table keeps the resolved concrete ids visible — unconfigured/unavailable tiers render the session-default id with a `(default)` marker — so transcripts still record which model a tier-named spawn actually used, rather than hiding selection behind an opaque label.

Keeping the full list always-injected was rejected as pure waste once tiers cover the common case: it costs tokens every session for discovery that is now rarely needed. Dropping model discovery entirely was rejected because explicitly naming a concrete model is still a supported (if unadvertised) path, and an agent needs some way to learn the catalog — hence `list_models` as pay-per-use discovery.

## Consequences
- Per-session prompt cost drops from ~16 lines to a four-row table plus short guidance, paid whether or not a subagent is spawned.
- Discovering the full catalog now costs a tool call instead of being free-on-arrival; acceptable because tiers are expected to satisfy the common case and the concrete-model path is the exception.
- Transcript legibility is preserved: the resolved model id stays visible in the tier table, so a reader can always see what a tier meant at spawn time.
- Config is read fresh on each injection and each spawn (files are tiny), so tier-table edits apply without `/reload`.
