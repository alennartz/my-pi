# DR-004: Rigidity Hierarchy — Architecture is Contract, Steps are Route, Details are Tactical

## Status
Accepted

## Context
During implementation, the agent needs to know what's sacred and what's adaptable. Plans predict the codebase state, but reality diverges — method names differ, files have moved, extra imports are needed. Needed a principle for when to follow the plan literally vs. adapt.

## Decision
Three tiers of rigidity: the architecture section (module boundaries, interfaces, patterns) is an inviolable hard constraint. Step sequence and scope are soft constraints — don't reorder, skip, or add steps without surfacing to the user. Step-level implementation details are flexible — the agent adapts the *how* when reality doesn't match predictions. When the agent encounters a situation where the architecture genuinely can't be followed — reality contradicts what was planned — it stops, marks the step `blocked` with an explanation, and surfaces the conflict to the user rather than silently deviating.

## Consequences
The architecture provides a stable contract that review can check against. The agent has clear latitude to handle tactical surprises without blocking. Deviations from step scope get surfaced rather than silently introduced. Architectural conflicts become explicit decision points for the user, preventing the agent from quietly undermining the plan's structural intent. This same hierarchy is what the code review skill checks against — plan adherence means architecture adherence, not character-for-character plan matching.
