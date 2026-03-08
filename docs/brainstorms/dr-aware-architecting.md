# Brainstorm: DR-Aware Architecting

## The Idea

The architecting skill has no awareness of decision records (`docs/decisions/`). This means it can re-ask questions the project has already settled, or make decisions that contradict existing DRs without realizing it. The fix is to make the architect phase DR-aware — check what's already been decided before starting the decision conversation.

## Key Decisions

### DR check happens after investigation, before decisions

**Why:** The agent needs full context about the current work (codemap, brainstorm, code) before it can evaluate which DRs are relevant. Reading them blind upfront would work but reading them after investigation means the agent knows what it's looking for and can connect DRs to what it found in the code.

### No special discovery mechanism — use normal tools

**Why:** The agent already knows how to `ls` a directory and read files. No tagging, metadata, or indexing needed. The skill just tells the agent the directory exists and that it should check it. The agent uses bash tools to scan and read as it normally would.

### DRs are treated as settled context during decisions

**Why:** Same treatment as brainstorm decisions. If a DR already covers a decision the agent would otherwise ask about, don't re-ask — treat it as settled and move on. Mention it so the user has visibility. Only revisit if the code investigation contradicts the reasoning behind the DR.

### Supersession is always a mandatory conversation with the user

**Why:** DRs represent project-level decisions with substantive reasoning. If the architect phase identifies a situation where a DR needs to be superseded, the agent must surface it explicitly — explain what it found, why the old DR no longer holds, and let the user decide. Never silently override.

### Superseded DRs stay in place during the workflow; cleanup handles the lifecycle

**Why:** The architect phase stays focused on decisions, not on managing DR files. The old DR remains in `docs/decisions/` during the workflow (no gap where neither old nor new exists). The plan captures a note flagging the supersession. Cleanup then handles the mechanics: capture the old DR's commit hash, delete it, write the new DR with a provenance note like "Supersedes DR-NNN (deleted, last seen at `abc123`)".

### Superseded DRs are deleted, not marked

**Why:** Keeping superseded DRs with a status change risks the agent reading stale decisions and following them despite filtering instructions. Deletion is zero-ambiguity — `docs/decisions/` is always a trustworthy set of current decisions. Historical reasoning is recoverable from git. The new DR documents what it replaced and includes the commit hash for traceability.

## Direction

Two changes:

1. **Architecting skill** — add a new sub-step between investigation (step 1) and decisions (step 2). The agent scans `docs/decisions/`, reads relevant DRs, and carries them forward as settled context. During decisions, DRs get the same "don't relitigate" treatment as brainstorm decisions. Supersession conflicts trigger a mandatory user conversation, with the outcome captured in the plan as a note for cleanup.

2. **Cleanup skill** — extend DR extraction to handle supersession notes from the plan. When the plan flags a supersession: capture the old DR's commit hash, delete the old DR, write the new DR with provenance.

## Open Questions

- None identified.
