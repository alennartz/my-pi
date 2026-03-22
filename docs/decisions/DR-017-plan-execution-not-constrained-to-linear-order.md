# DR-017: Plan Execution Is Not Constrained to Linear Order

## Status
Accepted

## Context
Supersedes DR-003 (Plan as Living Progress Tracker), deleted at commit `e657d02db4c63aad1cbb32911a0bb731eff75d05`.

The original DR locked plan steps into a "pure linear sequence" — the planner was responsible for getting ordering right, and the implementing skill walked through steps serially. With the introduction of module-aligned worker agents and channel-based dependency resolution, the implementer now decides at runtime how to batch and parallelize. The serial constraint was preventing concurrency even when steps were independent.

## Decision
The plan remains the living progress tracker — steps still have numbered ordering, status fields, and the plan file is still the single source of truth for progress. But step ordering is now authoring guidance (natural build sequence), not a concurrency constraint. The implementer evaluates module boundaries and step dependencies at runtime and decides whether to execute directly (trivial plans) or orchestrate concurrent workers (larger plans). Dependencies between concurrent workers are resolved via inter-agent channels, not step sequencing.

## Consequences
Plans are still resumable and self-documenting. The planner no longer carries the burden of predicting execution order perfectly — ordering is advisory. The implementer gains flexibility but also responsibility: it must judge independence correctly when parallelizing. The plan format is unchanged (numbered steps, status fields), so existing plans and the implementing skill's resumability logic still work.
