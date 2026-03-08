# DR-005: Plan-Grounded Code Review via Pre-Implementation Commit

## Status
Accepted

## Context
Needed a code review approach that's more actionable than generic feedback. The plan already captures what should have been built and why. Also needed a clean way to scope what changed during implementation vs. pre-existing code.

## Decision
Reviews are grounded in the plan as spec — "did we build what we said we'd build?" — not generic code quality commentary. Two passes: plan adherence first (meaningful deviations, incomplete work), then code correctness (bugs, unhandled errors, race conditions). Scope is determined by a `pre-implementation-commit` hash stamped into the plan file before implementation begins, providing a clean `git diff` baseline. Findings go to a separate `docs/reviews/<topic>.md` file, not back into the plan.

## Consequences
Reviews have a concrete reference point, making findings actionable and verifiable. The pre-implementation commit hash gives exact diff scope without relying on branch conventions. Separating findings from the plan keeps both artifacts single-purpose. The same plan-grounded approach means review severity is calibrated to what matters — reasonable adaptations are fine, meaningful drift gets flagged.
