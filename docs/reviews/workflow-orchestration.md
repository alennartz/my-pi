# Review: Workflow Orchestration

**Plan:** `docs/plans/workflow-orchestration.md`
**Diff range:** `acb8cef82e9f270f2a867afffd7b5120aff83a98..44087c463d0b116dec20db0ace85a9dfd2c74ae7`
**Date:** 2026-03-07

## Summary

The plan was faithfully implemented across all five steps. The extension structure, artifact inventory helper, prompt template, entry point with all three registrations (`/workflow`, `workflow_phase_complete`, `/workflow-new-session`), and codemap update all match the plan's architecture and specifications. One code correctness issue exists around unhandled `select()` cancellation in the flexible transition path, and one minor unplanned change was made outside the plan's scope.

## Findings

### 1. `ui.select()` cancellation falls through to "Start fresh context"

- **Category:** code correctness
- **Severity:** warning
- **Location:** `.pi/extensions/workflow/index.ts:139-149`
- **Status:** resolved

In the flexible transition branch, `ctx.ui.select()` returns `undefined` when the user cancels (ESC) or on timeout. The current code checks `if (choice === "Continue in this context") { ... } else { ... }`, so `undefined` falls into the `else` branch, which triggers `/workflow-new-session` — clearing the context. A user who cancels the dialog (intending "never mind, don't transition yet") would silently get a context-clearing session switch instead. The `undefined` case should be handled explicitly, likely by returning a "Transition cancelled" message to the LLM without sending any follow-up.

### 2. Unplanned change to implementing skill

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `skills/implementing/SKILL.md:66`
- **Status:** dismissed

A new principle was appended to the implementing skill: "Read only what you need — the plan and codemap are your primary context..." This change isn't traced to any step in the plan. It's a reasonable addition, but it modifies a file outside the plan's scope.

## Notes

### Phase identity threading across transitions

The transition code calls `buildPhasePrompt(topic, nextPhase)`, where `nextPhase` (e.g. `"architect"`) becomes the `phase` parameter inside the prompt. That prompt tells the LLM: "when done, call `workflow_phase_complete` with phase `architect`." So the tool always receives the phase that was *just completed*, validates the correct artifact (`PHASE_ARTIFACTS["architect"]` → `docs/plans/${topic}.md`), and computes the correct successor (`getNextPhase("architect")` → `"plan"`). The variable renaming from `nextPhase` at transition time to `phase` inside the prompt is slightly confusing to read, but the values thread correctly through every boundary. Verified by tracing the full brainstorm → architect → plan → implement → review → handle-review cycle. No issue.

## No Issues

Plan adherence: no significant deviations found beyond the nit above. All five steps were completed as specified — directory structure, `phases.ts` helper, `prompt.md` template, `index.ts` entry point (with all constants, helpers, commands, and tool), and codemap update all match the plan's architecture and detailed specifications.
