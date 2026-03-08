# DR-008: Flexible vs Mandatory Context Boundaries

## Status
Accepted

## Context
The pipeline has seven phases. Some transitions benefit from shared conversational context (brainstorm → architect is a natural continuation). Others require a clean slate (plan → implement needs the agent to work from the artifact, not from memory of the planning conversation). Needed a principled way to handle both.

## Decision
Two types of transitions. Flexible transitions (brainstorm → architect, architect → plan, review → handle-review) prompt the user to continue in the same context or start fresh. Mandatory transitions (plan → implement, implement → review) always clear context and start a new session. The LLM has no awareness of session mechanics — it calls `workflow_phase_complete` and the extension handles everything.

## Consequences
Implementation and review always start clean, working purely from artifacts — preventing the agent from relying on conversational memory instead of the written plan. Conversational phases can share context when it's useful. The clean separation means the LLM never needs to reason about session management. The extension owns all transition logic, making it testable and changeable without touching skill instructions.
