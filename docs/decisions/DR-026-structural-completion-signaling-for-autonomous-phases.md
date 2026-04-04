# DR-026: Structural Completion Signaling for Autonomous Phases

## Status
Accepted

## Context
The autonomous workflow (`/autoflow`) runs phases as subagents. Each subagent needs to signal whether its phase completed successfully or whether it needs help. The existing interactive workflow uses `workflow_phase_complete` — a registered tool the agent calls explicitly to mark a phase as done and trigger the transition. The question was whether subagents should use the same tool or a different mechanism.

## Decision
Subagents signal completion structurally: normal agent process exit means the phase is done, and blocking sends to parent (`send(to="parent", expectResponse=true)`) mean the subagent needs clarification before it can finish. The `workflow_phase_complete` tool is not registered in subagent processes (guarded by `PI_PARENT_LINK`), so it's not even available.

The parent validates success by checking artifacts after the subagent exits — not by trusting the subagent's self-report. Each phase has a defined artifact check (e.g., `## Tests` section exists in the plan after test-write, review file exists after review).

We rejected having subagents call `workflow_phase_complete` because the tool does more than signal completion — it manages session transitions, editor pre-fill, and context resets that are meaningless in a subagent context. Stripping it down to just signaling would have been possible, but structural completion is simpler: there's no tool to misuse, no edge case where the tool is called but the phase isn't actually done, and no ambiguity about what "done" means.

The trade-off is that artifact validation is now the parent's responsibility and must be maintained as a parallel source of truth alongside the skill definitions. If a skill's output format changes and the artifact checks aren't updated, the parent could incorrectly accept or reject a phase.

## Consequences
- Subagent completion is unambiguous — exit means done, blocking send means stuck.
- The parent owns transition validation via artifact checks (`checkTransitionArtifact()`), adding a maintenance surface that must stay in sync with skill output expectations.
- `workflow_phase_complete` remains available for the interactive `/workflow` path, untouched.
- If a subagent exits without producing the expected artifact (e.g., it gave up silently), the parent catches this via validation and can retry or escalate — a safety net that tool-based signaling wouldn't provide.
