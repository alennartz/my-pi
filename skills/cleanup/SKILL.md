---
name: cleanup
description: "Close out completed work — extract decision records, refresh the codemap, update user-facing docs, and delete working artifacts. Use when a feature or change is done and the repo needs tidying: plans consumed, decisions captured, documentation refreshed. Requires at minimum a plan in docs/plans/<topic>.md — if it doesn't exist, there's nothing to clean up."
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

5. **Read `docs/reviews/<topic>-tests.md`** — the test review. If it doesn't exist, skip it.

### 1. Spawn Background Agents

Before starting DR extraction, spawn two subagents as a fan-out — no inter-agent channels needed:

- **Codemap refresh agent** — give it the current codemap, the plan's `pre-implementation-commit` hash, and the architecture's impacted modules list. It runs the scoped codemap update: `git diff --name-only <hash>..HEAD` to find changed files, examines the changes, updates affected codemap sections, preserves everything else. Follows the codemap skill's scoped update operation.

- **Documentation pass agent** — give it the plan summary and the diff scope. It sweeps user-facing documentation in the repo (READMEs, AGENTS.md, contributing guides, API docs — whatever exists, no hardcoded list). For each document, checks whether anything shipped in this workflow makes it stale: descriptions that no longer match reality, missing references to new features, outdated examples, structural descriptions that don't reflect current organization. Updates what needs updating, leaves accurate docs alone.

These run in the background while you work on DR extraction.

### 2. Extract Decision Records

#### Handle Supersessions

Before extracting new DRs, check the plan for a `### DR Supersessions` section under Architecture. If it exists, process supersessions following the decision-records skill's supersession procedure.

#### Extract New Records

Scan the working artifacts (brainstorm, plan, review, test review) for decisions worth preserving. Follow the decision-records skill for quality criteria, format, file conventions, and proposal flow.

### 3. Wait for Background Agents

When DR extraction is complete, wait for the background agents' `<agent_idle>` notifications if they haven't finished yet. Review their output for sanity — the codemap should reflect the implementation changes, and docs should be accurate. If a background agent failed or produced incorrect output, redo that work yourself before proceeding.

### 4. Delete Working Artifacts

Remove the working artifacts for this topic:
- `docs/brainstorms/<topic>.md`
- `docs/plans/<topic>.md`
- `docs/reviews/<topic>.md`
- `docs/reviews/<topic>-tests.md`

Only delete files that actually exist.

### 5. Commit

Stage and commit all changes from this cleanup phase in a single commit with message: `cleanup: <topic> - <short description of what the commit contains>`

The description should briefly summarize what's in the commit — e.g., "decision records, codemap update, artifact removal" or "codemap and docs update, artifact removal". Keep it concise.

## Key Principles

- **Clean context** — this skill always starts fresh. Reconstruct everything from artifacts on disk.
- **Background delegation** — codemap and docs run as subagents while the primary handles DRs.
- **Decision record quality** — follow the decision-records skill for quality bar and proposal flow.
- **Scoped codemap update** — use the pre-implementation baseline and architecture to focus the update. Not a full rebuild.
- **Open-ended doc sweep** — discover what exists, don't assume a fixed set of files.
- **Extract before delete** — decision records are captured before working artifacts are removed.
- **Wait before committing** — don't delete artifacts or commit until background agents have finished and their output is reviewed.
- **Pipeline cap** — this skill runs after the pipeline completes. Some phases may have been skipped — the working artifacts reflect what was actually produced, not necessarily the full sequence.
