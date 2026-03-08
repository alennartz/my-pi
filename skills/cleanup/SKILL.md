---
name: cleanup
description: "Close out a completed workflow — extract decision records, refresh the codemap, update user-facing docs, and delete working artifacts. The final phase of the pipeline, after handle-review."
---

# Cleanup

## Overview

Close out a completed workflow pipeline. Extract lasting value from the working artifacts before deleting them, refresh the codemap, and make sure user-facing documentation still reflects reality.

This skill always runs in a clean context with no conversational history from prior phases. It reconstructs everything it needs from the artifacts on disk.

## Process

### 0. Gather Context

1. **Read `codemap.md`** at the repo root. If it doesn't exist, proceed without it.

2. **Read `docs/plans/<topic>.md`** — the plan. You need the architecture section's impacted modules list for the codemap refresh, and the `pre-implementation-commit` hash for scoping the diff. If the plan doesn't exist, tell the user and stop.

3. **Read `docs/brainstorms/<topic>.md`** — the brainstorm. If it doesn't exist, skip it.

4. **Read `docs/reviews/<topic>.md`** — the review. If it doesn't exist, skip it.

### 1. Extract Decision Records

Scan the working artifacts (brainstorm, plan, review) for decisions worth preserving. The bar is: **would this matter to someone working in this codebase six months from now?** Trivial or mechanical choices don't qualify. Look for decisions where alternatives were considered and a choice was made for substantive reasons — architectural trade-offs, scope decisions, technology choices, pattern selections, rejected approaches with instructive reasoning.

For each candidate decision record:

1. **Propose it to the user.** Present the title, a brief summary of the context, and what was decided. One at a time — don't batch them.
2. **The user approves, edits, or rejects.** If they edit, incorporate their changes. If they reject, move on.
3. **For approved records:** determine the next DR number by scanning `docs/decisions/` for the highest existing `DR-NNN` prefix. If the directory doesn't exist, create it and start at `DR-001`. Write the record to `docs/decisions/DR-NNN-<slug>.md` where `<slug>` is a kebab-case summary of the decision (not the topic slug — multiple DRs can come from one workflow).

Each decision record follows this format:

```markdown
# DR-NNN: <Title>

## Status
Accepted

## Context
<Why this decision was needed — the forces at play, what prompted it.>

## Decision
<What was decided and why.>

## Consequences
<What follows from this decision — benefits, trade-offs, things to watch for.>
```

Commit each approved decision record individually with message: `decision: DR-NNN <title>`

If the user rejects all proposed records, that's fine — proceed to the next step. The user had their chance to preserve what mattered.

### 2. Codemap Refresh

Update the codemap to reflect changes made during the workflow. This is the sole codemap update point in the pipeline — it covers implementation and review changes together.

1. **Get the diff scope.** Use the plan's `pre-implementation-commit` hash to run `git diff --name-only <hash>..HEAD`. This tells you what files changed.
2. **Combine with the architecture.** The plan's impacted modules list tells you which codemap modules to focus on.
3. **Do a scoped codemap update.** Follow the codemap skill's scoped update operation: read the current codemap, examine the changes, update affected sections, preserve everything else. Commit with message: `codemap: update`

### 3. Documentation Pass

Sweep user-facing documentation in the repo. Discover what exists — READMEs, AGENTS.md, contributing guides, API docs, whatever the repo has. No hardcoded list; use judgment about what's user-facing.

For each document found, check whether anything shipped in this workflow makes it stale. Look for:
- Descriptions that no longer match reality
- Missing references to new features, modules, or capabilities
- Outdated examples or instructions
- Structural descriptions that don't reflect current organization

Update what needs updating. Don't rewrite docs that are still accurate. Commit documentation updates with a descriptive message.

### 4. Delete Working Artifacts

Remove the working artifacts for this topic:
- `docs/brainstorms/<topic>.md`
- `docs/plans/<topic>.md`
- `docs/reviews/<topic>.md`

Only delete files that actually exist. Commit the deletion with message: `cleanup: remove working artifacts for <topic>`

## Key Principles

- **Clean context** — this skill always starts fresh. Reconstruct everything from artifacts on disk.
- **Higher bar for decision records** — only extract decisions that would matter six months from now. When in doubt, propose it and let the user decide.
- **One decision at a time** — don't batch decision record proposals. The user reviews each individually.
- **Scoped codemap update** — use the pre-implementation baseline and architecture to focus the update. Not a full rebuild.
- **Open-ended doc sweep** — discover what exists, don't assume a fixed set of files.
- **Extract before delete** — decision records are captured before working artifacts are removed.
- **Pipeline cap** — this skill only runs after a complete pipeline (brainstorm → architect → plan → implement → review → handle-review).
