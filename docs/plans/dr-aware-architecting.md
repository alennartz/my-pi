# Plan: DR-Aware Architecting

## Context

The architecting skill has no awareness of decision records (`docs/decisions/`), so it can re-ask settled questions or contradict existing DRs without realizing it. Adding DR-awareness to the architect phase and supersession handling to cleanup. See [brainstorm](../brainstorms/dr-aware-architecting.md).

## Architecture

### Impacted Modules

**Skills** — Two skill files are modified:

- `skills/architecting/SKILL.md` — gains a DR-check sub-step between investigation and decisions, plus DR-awareness behavior during the decision conversation (settled context treatment, mandatory supersession conversations).
- `skills/cleanup/SKILL.md` — gains supersession handling during DR extraction: read supersession notes from the plan, capture old DR's commit hash, delete old DR, write new DR with provenance.

**Docs** — `docs/decisions/` shifts from write-only (produced by cleanup) to read-write (consumed by architecting, produced/deleted by cleanup). No structural change needed — the directory already exists.

### Interfaces

The plan artifact format (`docs/plans/<topic>.md`) gains a new optional subsection under Architecture:

```markdown
### DR Supersessions

- **DR-NNN** (<title>) — superseded because [reason]. New decision: [summary of what replaces it].
```

Omitted when no DRs are being superseded (same convention as other optional sections). Cleanup reads this section to know which old DRs to delete and what provenance to include in replacement DRs.
