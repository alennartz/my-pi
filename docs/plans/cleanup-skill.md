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

## Steps

### Step 1: Create the cleanup skill

Create `skills/cleanup/SKILL.md` with YAML frontmatter (`name: cleanup`, description) and structured sections following the same pattern as existing skills. The skill's process:

0. **Gather Context** — Read `codemap.md`, read the plan at `docs/plans/<topic>.md` (for the architecture section's impacted modules list), and read the remaining working artifacts (`docs/brainstorms/<topic>.md`, `docs/reviews/<topic>.md`). Be defensive — not all files may exist.

1. **Extract Decision Records** — Scan the working artifacts for decisions that clear the "would this matter six months from now" bar. For each candidate, propose it to the user with the title, context, and decision summary. User approves, edits, or rejects. For approved records: scan `docs/decisions/` for the highest existing `DR-NNN` number (create the directory if it doesn't exist), increment, write `docs/decisions/DR-NNN-<slug>.md` in the standard format (Title, Status, Context, Decision, Consequences). Commit each approved DR individually.

2. **Codemap Refresh** — Do a scoped codemap update using directional scope: tell the codemap skill that review changes were made for the topic and which modules were impacted (pulled from the plan's architecture section), then let it verify the codemap still reflects reality for those areas. Not a full rebuild — just a targeted check.

3. **Documentation Pass** — Open-ended sweep of user-facing documentation in the repo. Discover what exists (READMEs, AGENTS.md, guides, etc. — no hardcoded list, use judgment), check whether anything shipped in this workflow makes them stale, update what needs updating. Commit updates.

4. **Delete Working Artifacts** — Remove `docs/brainstorms/<topic>.md`, `docs/plans/<topic>.md`, `docs/reviews/<topic>.md`. Only delete files that exist. Commit the deletion.

**Verify:** File exists at `skills/cleanup/SKILL.md`, has valid YAML frontmatter, covers all four process steps with the details above.
**Status:** not started

### Step 2: Update workflow extension

In `extensions/workflow/index.ts`:
- Add `cleanup: "cleanup"` to `PHASE_SKILL_MAP` (line 13–19)
- Append `"cleanup"` to `PHASE_ORDER` (line 22)
- Add `"cleanup"` to the `StringEnum` array in the `workflow_phase_complete` tool's parameters (line 148)
- Change the artifact validation block (lines 155–158): replace `if (!artifactPathFn) { throw new Error(...) }` with a conditional skip — if no entry exists in `PHASE_ARTIFACTS` for the phase, skip validation entirely and proceed to the next-phase logic

In `extensions/workflow/phases.ts`:
- Add `"docs/decisions"` to the `ARTIFACT_DIRS` array (line 4)

In `extensions/workflow/prompt.md`:
- Add `7. **cleanup** → skill: \`cleanup\`` to the phase list after handle-review

**Verify:** Read all three files and confirm the changes are correct. No build step (raw TS, loaded at runtime).
**Status:** not started

### Step 3: Update AGENTS.md

Add the cleanup skill to the available skills description in `AGENTS.md`, following the same format as existing entries (name, description, location).

**Verify:** The cleanup skill appears in AGENTS.md with correct name, description, and path.
**Status:** not started

### Step 4: Update codemap

Update `codemap.md` to reflect: new cleanup skill in the Skills module responsibilities, updated pipeline flow (7 phases including cleanup), `docs/decisions` as a new artifact location in the Docs module, updated key flows diagram to include the cleanup phase.

**Verify:** Codemap accurately reflects the current state of the codebase.
**Status:** not started
