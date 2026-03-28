# DR-023: Five-Phase Design Pipeline

## Status
Accepted

## Context
Supersedes DR-002 (Three-Phase Design Pipeline — Brainstorm, Architect, Plan), deleted at commit `c1b5dcd6963e68578ece7af819442102dfce3cab`.

The three-phase design pipeline (brainstorm, architect, plan) had the planner producing both tests and implementation steps in the same context. This meant tests aligned with the implementation's assumptions rather than independently validating behavior — the agent exhibited confirmation bias where both tests and code agreed with the same (possibly wrong) interpretation of the plan.

## Decision
Expand to five design phases: brainstorm, architect, test-write, test-review, impl-plan. The test writer receives only architecture artifacts — component boundaries, interfaces, data flow — with no implementation plan or internal design. A dedicated test review phase validates tests against brainstorm intent before implementation planning begins. Implementation planning then takes architecture plus reviewed tests as input, so tests genuinely drive the implementation rather than the reverse.

The alternative was making TDD opt-in per task, but maintaining two pipeline shapes added complexity without clear benefit — the overhead of the extra phases is acceptable given the value of independent test validation.

## Consequences
The architect must produce interface descriptions thorough enough for the test writer to materialize as code without making design decisions — this raises the bar on the architecture phase's output. Implementation planning loses its general TDD guidance (tests already exist by that point). The pipeline is longer (9 phases total) but each phase has a tighter scope ceiling. The context boundary between test writing and implementation is the key enforcement mechanism — if it's relaxed, the independence guarantee disappears.
