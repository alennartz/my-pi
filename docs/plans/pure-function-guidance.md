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
