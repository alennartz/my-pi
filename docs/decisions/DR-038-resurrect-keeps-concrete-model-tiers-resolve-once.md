# DR-038: Resurrect keeps the concrete model; tiers resolve once at spawn

## Status
Accepted

## Context
Model tiers resolve a tier name (`cheap`, `medium`, `smart`, `frontier`) to a concrete model id at spawn time. Tier config is machine/project-local and can be edited at any point, so the model a given tier maps to can change over a session's lifetime. `resurrect` revives a torn-down agent from its persisted session file, which records the concrete model the agent last ran on.

This raised a question: when a tier-spawned agent is resurrected after its tier's mapping has changed, should it pick up the new mapping or keep its original concrete model?

## Decision
Resolve tiers exactly once, at spawn. `resurrect` inherits the concrete model recorded in the resumed session and never re-resolves against current tier config. `fork` has no model parameter and likewise inherits. Only a fresh spawn consults tier config.

Re-resolving on resurrect was rejected: a tier remapping silently changing a resurrected agent's model mid-lineage would be surprising, and the agent's persisted history was produced under the original model. This mirrors the boundary DR-033 draws for persona (resurrect re-resolves persona from the persistence log) — persona is re-derived from what was recorded, and model is likewise taken from what was recorded, not recomputed from a config that may have drifted.

## Consequences
- A resurrected agent is deterministic with respect to its own history: the model it ran on is the model it resumes on, independent of later config edits.
- To move a lineage onto a newly-remapped tier, the operator must spawn a fresh agent rather than resurrect — an intentional, visible action rather than a silent side effect of editing config.
- Tier resolution stays a spawn-time-only concern for every path that declares no model, keeping `resolveModelRef` off the fork path entirely and off the resurrect path unless the caller declares one (see the amendment below).

## Amendment: resurrect accepts a declared model

Resurrection now resolves a model when something declares one, under the spawn precedence: persona `model` pin, then an explicit `resurrect` item `model`, then nothing. When nothing declares a model, no override reaches construction and this DR's rule stands unchanged — the resumed session keeps the concrete model it last ran on, and tier config drift never moves it.

The reason for the exception: a caller that names a model on `resurrect` is making the same deliberate choice a caller makes on `subagent`. Refusing it forced teardown plus a fresh spawn, which discards the transcript the caller wanted to keep. Precedence therefore follows construction, not the tool name.

The drift concern this DR names survives in a narrower form: a pinned persona now re-resolves its tier on resurrection, so remapping that tier changes the model of every pinned agent revived afterwards. That is the declared pin doing its job, not silent drift.
