# Plan: Cleanup Skill

## Context

A new "cleanup" skill to serve as the 7th and final phase of the workflow pipeline. It extracts decision records from working artifacts, does a light codemap refresh, sweeps user-facing docs, and deletes the working files. See [brainstorm](../brainstorms/cleanup-skill.md).

## Architecture

### Impacted Modules

**Skills** — gains a new `skills/cleanup/SKILL.md` file. No changes to existing skills. The skill reads working artifacts (`docs/brainstorms/<topic>.md`, `docs/plans/<topic>.md`, `docs/reviews/<topic>.md`), proposes decision records to the user one at a time, writes approved records to `docs/decisions/`, invokes the codemap skill for a scoped update, does an open-ended user-facing docs sweep, then deletes the working artifacts. Always runs in a clean context with no conversational history from prior phases.

**Workflow Extension** — updated to include the cleanup phase:
- `PHASE_ORDER`: append `"cleanup"`
- `PHASE_SKILL_MAP`: add `cleanup: "cleanup"`
- `PHASE_ARTIFACTS`: no entry for cleanup (it deletes artifacts rather than producing one). The `workflow_phase_complete` tool is updated to skip artifact validation when a phase has no entry in `PHASE_ARTIFACTS`.
- `ARTIFACT_DIRS`: add `"docs/decisions"` so inventory scanning picks up existing decision records
- `FLEXIBLE_TRANSITIONS`: cleanup is NOT added — it always runs in a mandatory new context
- `prompt.md`: add cleanup as the 7th pipeline phase

**Docs** — `AGENTS.md` and `codemap.md` updated to reflect the new skill and pipeline phase. Done as part of implementation, not a separate architectural concern.

### Interfaces

**Decision record file format** — `docs/decisions/DR-NNN-<slug>.md` where NNN is zero-padded 3-digit number continuing from the highest existing entry. Slug is kebab-case summary of the decision (not the topic slug — multiple DRs can come from one workflow).

Each file:
```markdown
# DR-NNN: <Title>

## Status
Accepted

## Context
<Why this decision was needed>

## Decision
<What was decided>

## Consequences
<What follows from this decision>
```

**Artifact validation change** — `workflow_phase_complete` currently requires every phase to have an entry in `PHASE_ARTIFACTS`. Updated to treat a missing entry as "no artifact to validate" and skip the check. This only affects the cleanup phase.
