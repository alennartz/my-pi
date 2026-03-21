# Plan: Pure Function Guidance

## Context

Embed design guidance into the planning and implementing skills to counteract LLMs' tendency to default to shared mutable state. See [brainstorm](../brainstorms/pure-function-guidance.md).

## Architecture

### Impacted Modules

**Skills** — Two skill files are modified:

- `skills/planning/SKILL.md` — Gets a new Key Principle bullet stating the pure-function default and shared-mutable-state checkpoint, plus a paragraph in the "Generate the Plan" process step that puts the guidance in the planner's execution path. The planner should design data flow around explicit argument passing and pure functions. When shared mutable state seems warranted, it surfaces the decision to the user before writing the step.

- `skills/implementing/SKILL.md` — Gets a new Key Principle bullet stating the pure-function default as an execution-time principle, plus a paragraph in the "Execute Each Step" process step (substep 2, "Do the work") that catches micro-design choices. When the implementer is about to introduce shared mutable state — even for decisions the plan didn't explicitly address — it flags this to the user.

**Key design constraint:** Shared *immutable* state (config loaded once, constants, frozen data structures) is fine and requires no checkpoint. Only shared *mutable* state triggers the user-approval requirement.

**Not impacted:** The architecting skill is excluded — its existing conversational decision-making process already surfaces structural choices to the user one at a time.

## Steps

**Pre-implementation commit:** `b0a5e3974251b02b3657bd7e19d30edeebf26fd0`

### Step 1: Add pure-function guidance to the planning skill's "Generate the Plan" section

In `skills/planning/SKILL.md`, after the "Code snippets in steps" paragraph and before "Present the full plan to the user for review," insert a new paragraph covering:
- Default to designing data flow through explicit argument passing and pure functions
- Shared immutable state is fine (config, constants, frozen structures)
- If a step's design requires shared mutable state, surface it to the user with reasoning before writing the step

**Verify:** Read the file; the new paragraph sits between "Code snippets in steps" and "Present the full plan." It reads naturally in the flow of Step 2 guidance.
**Status:** done

### Step 2: Add pure-function principle to the planning skill's Key Principles

In `skills/planning/SKILL.md`, add a new bullet to the Key Principles section:
- **Pure functions by default** — design data flow through explicit argument passing and pure functions. Shared immutable state is fine. Shared *mutable* state requires surfacing the decision to the user with reasoning before writing it into a step.

**Verify:** Read the Key Principles section; the new bullet is present and consistent with the process paragraph from Step 1.
**Status:** done

### Step 3: Add pure-function guidance to the implementing skill's "Do the work" substep

In `skills/implementing/SKILL.md`, after substep 2 ("Do the work.") in the Execute Each Step list, insert guidance:
- Default to pure functions with explicit argument passing when writing code
- Shared immutable state is fine
- If introducing shared mutable state — even for micro-design decisions the plan didn't address — flag it to the user before proceeding

Also soften the "One shot" Key Principle to make room for discovery-based interrupts.

**Verify:** Read the file; the guidance is naturally integrated into the "Do the work" substep.
**Status:** done

### Step 4: Add pure-function principle to the implementing skill's Key Principles

In `skills/implementing/SKILL.md`, add a new bullet to the Key Principles section — the execution-time version:
- **Pure functions by default** — default to pure functions with explicit argument passing. Shared immutable state is fine. If you're introducing shared mutable state the plan didn't call for, surface it to the user before proceeding.

**Verify:** Read the Key Principles section; the new bullet is present and consistent with the process guidance from Step 3.
**Status:** not started
