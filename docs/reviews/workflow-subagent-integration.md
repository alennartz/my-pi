# Review: Workflow–Subagent Integration

**Plan:** `docs/plans/workflow-subagent-integration.md`
**Diff range:** `05370e6595ffc6e8183b6add80d483955d5f9917..08d28e51dc7a64342514d5739d99247a34485150`
**Date:** 2026-03-22

## Summary

The plan was implemented faithfully — all 7 steps are done, the architecture's intent (prose-only changes to 5 skill files, no extension or module changes) was followed exactly, and each step's verify criteria are met. Two code correctness warnings surfaced: the newly added orchestration patterns in the implementing and cleanup skills lack failure-handling guidance, which could leave an agent without instructions when workers fail or get stuck.

## Findings

### 1. No worker failure handling in orchestrated execution mode

- **Category:** code correctness
- **Severity:** warning
- **Location:** `skills/implementing/SKILL.md:63-76`
- **Status:** open

The direct execution path (section 1a) has clear guidance for verification failures: "try to fix it. Adapt, debug, iterate. If you resolve it, carry on. If you can't — you're going in circles or genuinely stuck — mark the step `blocked` with an explanation, commit that state, and stop." The orchestrated execution path (section 1b) has no equivalent. It describes workers executing, verifying, and reporting completion — but never addresses what happens when a worker's verification fails, when a worker gets stuck, or when a worker encounters an unresolvable problem. The "Handling Reality vs. Plan" section mentions workers escalating architecture conflicts, but there's no guidance on the mechanical flow for general failures: does the primary tear down the group? Mark the step blocked? Try to respawn? An agent in orchestrated mode would have to improvise through failure scenarios.

### 2. No guidance when background cleanup agents fail

- **Category:** code correctness
- **Severity:** warning
- **Location:** `skills/cleanup/SKILL.md:27-35`
- **Status:** open

The cleanup skill instructs the primary to spawn two background agents (codemap refresh and documentation pass), then "wait for `<group_idle>` if the background agents haven't finished yet. Review their output for sanity." But there's no guidance for what happens if a background agent fails — produces incorrect output, crashes, or never completes. What should the primary do if the codemap update is wrong? Redo it manually? What if an agent is stuck? The "Review their output for sanity" instruction is good but covers only the happy path. Since codemap accuracy and doc correctness matter for downstream work, an agent encountering a failed background task would have to improvise.

## No Issues

Plan adherence: no significant deviations found. All 7 steps were implemented faithfully — scout-verb changes in architecting and planning, constraint relaxation in planning, implementing skill rewrite with dual execution model, code-review parallel passes hint, cleanup restructuring for background delegation, and the final commit. The architecture's scope (prose-only, 5 skill files, no extension changes) was respected throughout.
