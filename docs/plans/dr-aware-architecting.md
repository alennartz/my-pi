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

## Steps

**Pre-implementation commit:** `d3c6db921eb7fe3e9b5c12aa8fc345583d910899`

### Step 1: Add DR check sub-step to architecting skill

Insert a new step `### 2. Check Decision Records` between the current step 1 (Investigate) and step 2 (Decide). This renumbers the old step 2 to step 3 and old step 3 to step 4. The new step instructs the agent to:

- Scan `docs/decisions/` using normal tools (ls, read)
- Read DRs that are relevant to the current work (now that the agent has context from the codemap, brainstorm, and code investigation)
- Identify which existing decisions are relevant — these become settled context for the decision conversation

In `skills/architecting/SKILL.md`:
- Insert the new `### 2. Check Decision Records` section after `### 1. Investigate`
- Renumber `### 2. Decide, One at a Time` → `### 3. Decide, One at a Time`
- Renumber `### 3. Capture the Outcome` → `### 4. Capture the Outcome`

**Verify:** The process section has steps 0, 1, 2, 3, 4 in order: Check for Context, Investigate, Check Decision Records, Decide, Capture the Outcome.
**Status:** done

### Step 2: Add DR-awareness behavior to the decision step

In the renamed step 3 (Decide, One at a Time), add a paragraph after the existing "Don't relitigate brainstorm decisions" block. The new paragraph covers two behaviors:

1. **DRs as settled context** — same treatment as brainstorm decisions. If a DR already covers a decision the agent would otherwise ask about, don't re-ask. Mention you're following it so the user has visibility. Only revisit if the code investigation contradicts the reasoning in the DR.
2. **Supersession is a mandatory conversation** — if a decision being made contradicts an existing DR, the agent must stop, surface the conflict explicitly (which DR, what it says, what contradicts it), and let the user decide. Never silently override. If the user agrees to supersede, capture it in the plan's DR Supersessions section.

**Verify:** Step 3 contains both the existing brainstorm relitigation guidance and the new DR-awareness guidance as distinct paragraphs.
**Status:** done

### Step 3: Add DR Supersessions to the artifact format

In the artifact format template in `skills/architecting/SKILL.md`, add an optional `### DR Supersessions` subsection under `## Architecture`. Add a corresponding format rule explaining: list each superseded DR with its number, title, reason for supersession, and summary of the replacement decision. Omit when no DRs are being superseded.

**Verify:** The artifact format template includes `### DR Supersessions` and a format rule describes its usage and optional nature.
**Status:** done

### Step 4: Add DR-awareness key principle

Add a new bullet to the Key Principles section of `skills/architecting/SKILL.md`:

- **Decision records are settled context** — check `docs/decisions/` before making decisions. Follow existing DRs; superseding one is always a conversation with the user.

**Verify:** Key Principles section contains the new bullet.
**Status:** done

### Step 5: Add supersession handling to cleanup skill

In `skills/cleanup/SKILL.md`, extend step 1 (Extract Decision Records) to handle supersession. Add a new sub-section or paragraph before the existing DR extraction logic that instructs:

1. Check the plan's `### DR Supersessions` section. If it exists, process each supersession entry:
   - Capture the old DR's last commit hash using `git log -1 --format=%H -- docs/decisions/DR-NNN-<slug>.md`
   - Delete the old DR file
   - Commit the deletion with message `decision: delete DR-NNN <title> (superseded)`
2. Then proceed with normal DR extraction from working artifacts. When writing a new DR that replaces a superseded one, include a provenance line in the Context section: `Supersedes DR-NNN (<title>), deleted at commit \`abc123\`.`

**Verify:** Cleanup skill's step 1 describes the full supersession flow: read plan for supersessions, capture hash, delete old DR, commit, then write replacement with provenance during normal extraction.
**Status:** not started
