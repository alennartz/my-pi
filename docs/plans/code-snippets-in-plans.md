# Plan: Code Snippets in Plans

## Context

The planning and architecting agents avoid code snippets in plan artifacts even when code would be clearer, due to an implicit norm. The original concern — not pre-empting TDD — is valid, but needs to be made explicit and nuanced rather than operating as a blanket ban. See [brainstorm](../brainstorms/code-snippets-in-plans.md).

## Architecture

### Impacted Modules

**Skills** — Two skill files need explicit guidance on when code snippets are appropriate in plan artifacts:

- `skills/architecting/SKILL.md` — Add a code-snippets principle to Key Principles. The existing Interfaces format rule ("Pseudocode or type signatures are fine if they clarify; don't force them if prose is clearer") already permits code in the right places; the new principle provides the broader reasoning and TDD context so the agent applies similar judgment across all architecture sections, not just Interfaces.

- `skills/planning/SKILL.md` — Add guidance to the "Generate the Plan" process section (step 2), where the agent is actively deciding how to express each step. Add a matching principle to Key Principles. Both include the TDD reasoning so the agent understands why implementations are off-limits but shape (interfaces, data structures, important signatures) is encouraged when clearer than prose.
