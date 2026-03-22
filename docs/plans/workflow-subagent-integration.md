# Plan: Workflow–Subagent Integration

## Context

Workflow skills currently assume the primary agent does all work itself — reading files, writing code, running reviews. Long implementations exhaust context, and phases with independent work run sequentially when they could parallelize. We're embedding subagent orchestration hints directly in skill prose so the primary naturally delegates. See `docs/brainstorms/workflow-subagent-integration.md`.

## Architecture

### Impacted Modules

**Skills** — five skill files edited, no new modules or extension changes needed. The subagent infrastructure (channels, fan-out, scout agent, orchestrating-agents skill) already supports everything.

- `skills/implementing/SKILL.md` — heavy rewrite of the execution model. Primary becomes a phase-level orchestrator that spawns module-aligned worker agents with inter-agent channels. Workers execute steps and communicate to unblock dependencies (not serialized). Workers message the parent as steps complete so the primary can mark them off in the plan in real-time. Commits happen when the group goes idle, giving the primary a checkpoint to review and decide the next phase. On larger plans, the primary slices work into phases — not for dependency management (channels handle that) but for the primary's own control: review, commit, course-correct, engage the user if needed. Workers do not edit the plan file or commit.

- `skills/planning/SKILL.md` — two changes: (1) swap investigation-phase language from read/explore verbs to "scout" verbs, and (2) remove the "pure linear order — no parallel annotations, no dependency graphs" constraint. Everything else stays — steps are still numbered, still have status and verify fields.

- `skills/code-review/SKILL.md` — add hint to run plan adherence and code correctness passes as two parallel subagents on the same diff. Both receive the plan and diff as input, neither needs the other's output. Clean fan-out, no channels. Primary merges findings into the final review document following the existing artifact format.

- `skills/cleanup/SKILL.md` — restructure to spawn subagents for codemap refresh and documentation pass *before* starting DR extraction. Primary works on DRs (conversational, needs user) while subagents run in the background. When both are done, primary deletes artifacts and commits.

- `skills/architecting/SKILL.md` — swap investigation-phase language from read/explore verbs to "scout" verbs. Decision-making flow unchanged.

### Interfaces

No interface changes. Skills are prose documents consumed by the agent — no APIs, no contracts between modules. The subagent tool suite, scout agent definition, and orchestrating-agents skill are unchanged.

### DR Supersessions

- **DR-003** (Plan as Living Progress Tracker) — superseded because the "pure linear sequence" constraint no longer holds. The implementer now orchestrates module-aligned workers that execute concurrently, with dependencies resolved via inter-agent channels rather than step ordering. New decision: the plan remains the living progress tracker with status fields and resumability, but steps are no longer constrained to pure linear execution. The implementer decides how to batch and parallelize at runtime based on module boundaries and step dependencies. The planner still numbers steps sequentially (it's a natural authoring order) but this ordering is not a parallelism constraint.
