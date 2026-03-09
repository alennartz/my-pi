# Plan: Code Snippets in Plans

## Context

The planning and architecting agents avoid code snippets in plan artifacts even when code would be clearer, due to an implicit norm. The original concern — not pre-empting TDD — is valid, but needs to be made explicit and nuanced rather than operating as a blanket ban. See [brainstorm](../brainstorms/code-snippets-in-plans.md).

## Architecture

### Impacted Modules

**Skills** — Two skill files need explicit guidance on when code snippets are appropriate in plan artifacts:

- `skills/architecting/SKILL.md` — Add a code-snippets principle to Key Principles. The existing Interfaces format rule ("Pseudocode or type signatures are fine if they clarify; don't force them if prose is clearer") already permits code in the right places; the new principle provides the broader reasoning and TDD context so the agent applies similar judgment across all architecture sections, not just Interfaces.

- `skills/planning/SKILL.md` — Add guidance to the "Generate the Plan" process section (step 2), where the agent is actively deciding how to express each step. Add a matching principle to Key Principles. Both include the TDD reasoning so the agent understands why implementations are off-limits but shape (interfaces, data structures, important signatures) is encouraged when clearer than prose.

## Steps

### Step 1: Add code-snippets principle to architecting skill

In `skills/architecting/SKILL.md`, add a new bullet to the **Key Principles** section (after the existing bullets). The principle should explain the TDD reasoning and the "prefer prose, use code for shape" guideline.

**Verify:** The Key Principles section in `skills/architecting/SKILL.md` contains a new bullet about code snippets with TDD reasoning.
**Status:** not started

### Step 2: Add code-snippets guidance to planning skill's "Generate the Plan" section

In `skills/planning/SKILL.md`, add a paragraph to the end of **section 2 ("Generate the Plan")**, after the existing TDD paragraph. The paragraph should explain when code snippets are appropriate in plan steps (interfaces, data structures, important signatures) vs. not (implementations, function bodies), and why — the TDD pre-emption concern.

**Verify:** The "Generate the Plan" section in `skills/planning/SKILL.md` contains new guidance about code snippets after the TDD paragraph.
**Status:** not started

### Step 3: Add code-snippets principle to planning skill

In `skills/planning/SKILL.md`, add a new bullet to the **Key Principles** section reinforcing the same guideline. Shorter than the process section guidance — a principle-level summary.

**Verify:** The Key Principles section in `skills/planning/SKILL.md` contains a new bullet about code snippets.
**Status:** not started
