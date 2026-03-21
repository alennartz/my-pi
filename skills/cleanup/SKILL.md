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

#### Handle Supersessions

Before extracting new DRs, check the plan for a `### DR Supersessions` section under Architecture. If it exists, process supersessions following the decision-records skill's supersession procedure.

#### Extract New Records

Scan the working artifacts (brainstorm, plan, review) for decisions worth preserving. Follow the decision-records skill for quality criteria, format, file conventions, and proposal flow.

### 2. Codemap Refresh

Update the codemap to reflect changes made during the workflow. This is the sole codemap update point in the pipeline — it covers implementation and review changes together.

1. **Get the diff scope.** Use the plan's `pre-implementation-commit` hash to run `git diff --name-only <hash>..HEAD`. This tells you what files changed.
2. **Combine with the architecture.** The plan's impacted modules list tells you which codemap modules to focus on.
3. **Do a scoped codemap update.** Follow the codemap skill's scoped update operation: read the current codemap, examine the changes, update affected sections, preserve everything else.

### 3. Documentation Pass

Sweep user-facing documentation in the repo. Discover what exists — READMEs, AGENTS.md, contributing guides, API docs, whatever the repo has. No hardcoded list; use judgment about what's user-facing.

For each document found, check whether anything shipped in this workflow makes it stale. Look for:
- Descriptions that no longer match reality
- Missing references to new features, modules, or capabilities
- Outdated examples or instructions
- Structural descriptions that don't reflect current organization

Update what needs updating. Don't rewrite docs that are still accurate.

### 4. Delete Working Artifacts

Remove the working artifacts for this topic:
- `docs/brainstorms/<topic>.md`
- `docs/plans/<topic>.md`
- `docs/reviews/<topic>.md`

Only delete files that actually exist.

### 5. Commit

Stage and commit all changes from this cleanup phase in a single commit with message: `cleanup: <topic> - <short description of what the commit contains>`

The description should briefly summarize what's in the commit — e.g., "decision records, codemap update, artifact removal" or "codemap and docs update, artifact removal". Keep it concise.

## Key Principles

- **Clean context** — this skill always starts fresh. Reconstruct everything from artifacts on disk.
- **Decision record quality** — follow the decision-records skill for quality bar and proposal flow.
- **Scoped codemap update** — use the pre-implementation baseline and architecture to focus the update. Not a full rebuild.
- **Open-ended doc sweep** — discover what exists, don't assume a fixed set of files.
- **Extract before delete** — decision records are captured before working artifacts are removed.
- **Pipeline cap** — this skill only runs after a complete pipeline (brainstorm → architect → plan → implement → review → handle-review).
