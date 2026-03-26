# Plan: Plan Blind Spot Check

## Context

The code-review skill is plan-anchored — it checks implementation against the plan. But when the plan itself has a gap (intent from the brainstorm that didn't become a step), the review can't catch it. Adding a blind spot check at plan time catches these gaps before implementation begins. See [brainstorm](../brainstorms/plan-blind-spot-check.md).

## Architecture

### Impacted Modules

**Skills (Planning)** — gains a new phase between writing the plan to disk and committing. After the plan steps are written, if a brainstorm exists for the topic, the planner spawns a default subagent with the brainstorm and plan file paths. The subagent reads both files and identifies brainstorm intent that the plan doesn't cover. The planner reviews the subagent's output and surfaces substantive findings to the user, who decides what (if anything) becomes new plan steps. The plan is then updated if needed, and committed.

### Interfaces

**Blind spot subagent task contract** — the subagent receives file paths to `docs/brainstorms/<topic>.md` and `docs/plans/<topic>.md` in its task description. It reads both, compares intent against coverage, and returns a list of gaps as prose in its completion output. Each gap identifies the brainstorm intent that's missing and why it isn't covered by existing steps. The subagent doesn't write files or modify the plan — it only produces findings.

**Planner ↔ user for findings** — the planner reviews the subagent's output, filters noise (e.g., things already covered by existing steps that the subagent misjudged), and presents remaining findings to the user conversationally. The user decides per-finding: add a step, dismiss as already covered, or dismiss as out of scope. New steps get appended with the next sequential number and `not started` status.
