# DR-036: Model tiers fold into the subagents extension, not a standalone extension

## Status
Accepted

## Context
Named model-intelligence tiers (`cheap`, `medium`, `smart`, `frontier`) were introduced so skills and agent definitions could select subagent models by a stable vocabulary that survives model churn and stays configurable per machine/project. The motivating consumer was phase-appropriate model selection in the autoflow pipeline.

The feature was originally conceived as its own extension, pulled in as a dependency by autoflow. The two integration points it needs, however, both already live inside the subagents extension: the always-injected "Available Models" system-prompt block and the `model`-field validation/resolution path that handles both `subagent` tool overrides and agent-definition `model` pins.

## Decision
Extend `extensions/subagents/` directly rather than ship a standalone extension. Tier config loading and tier-aware resolution live alongside the spawn path; a pure-function module (`model-tiers.ts`) holds the resolution logic with colocated tests, matching the module's existing convention.

A standalone extension was rejected because it would have to intercept another extension's tool calls — cross-extension coupling with no consumer other than autoflow, which ships in the same package regardless. The seam it would straddle (system-prompt injection and `model` resolution) is internal to subagents, so a separate extension buys isolation nobody needs while paying for a fragile interception boundary.

## Consequences
- Tier logic is owned by the one module that already owns model selection for subagents; no cross-extension contract to keep in sync.
- The subagents extension grows a new responsibility (config loading, tier resolution, `list_models`), so it is no longer purely lifecycle/orchestration — acceptable because model selection was already its concern.
- A future non-subagent consumer of tiers (e.g. top-level model selection) would not get this for free; it would need its own resolution path or a promotion of `model-tiers.ts` to a shared location. That refactor is cheap because the resolution logic is already pure and I/O-free.
