---
name: code-review
description: "Review implemented code against its plan. Use when changes have been made and need checking — after implementation, before pushing, or when the user asks for a review. Requires a plan in docs/plans/<topic>.md with a pre-implementation-commit field — if the plan doesn't exist, suggest running the earlier pipeline phases first."
---

# Code Review

## Overview

Review what was built against what was planned. Read the plan, read the diff, and produce a findings report. Two passes: first check that the plan was faithfully implemented, then check that the code itself is sound.

The output is a findings file — not a conversation, not a fix. The review runs straight through and produces `docs/reviews/<topic>.md`. What happens next is the user's call.

## Process

### 0. Gather Context

1. **Read `codemap.md`** at the repo root. If it doesn't exist, proceed without it — the plan and diff are the primary inputs.

2. **Read `docs/plans/<topic>.md`** — the full plan: architecture, steps, and status fields. If the plan doesn't exist, tell the user and stop. Suggest running the architecting and planning skills first to establish the plan this review checks against. If the plan has no `pre-implementation-commit` field, ask the user for a commit hash or ref to diff from.

3. **Get the diff.** Use the `pre-implementation-commit` field from the plan to run `git diff <commit>..HEAD`. This is the scope of review — everything that changed during implementation.

4. **Read the changed files in full.** The diff tells you what changed, but review requires understanding context. Read the full current version of files with non-trivial changes. Don't read every file touched — use judgment about which files need full context (e.g., a file with 2 lines changed in a 500-line module probably needs the full read; a new file is already fully visible in the diff).

### 0.5. Run Passes in Parallel

Sections 1 and 2 are independent — they both operate on the same plan and diff but neither needs the other's output. Spawn two subagents as a fan-out: one for the plan adherence pass, one for the code correctness pass. Give each the plan content, the diff, and the full file reads from step 0. No inter-agent channels needed.

When both complete, merge their findings into the final review document (section 3). Deduplicate if both flagged the same issue; preserve the more detailed write-up.

### 1. Plan Adherence Pass

Compare the plan against the diff. For each step in the plan, check:

- **Was it done?** Is the work described in the step reflected in the diff?
- **Was it done correctly?** Does the implementation match the intent of the step and the architecture, not just superficially?
- **Was anything missed?** Requirements from the plan that have no corresponding changes.

Also check the reverse:

- **Was anything done that wasn't planned?** Changes in the diff that don't trace back to any step. Unplanned work isn't automatically wrong, but it should be noted.

**Use judgment on deviations.** Reasonable adaptations are normal during implementation — method names differ slightly, an extra edge case is handled, a file lives in a slightly different path than the plan assumed. These aren't findings. Flag deviations where the intent drifted: planned validation that's missing, a module boundary that was ignored, a pattern the architecture specified that wasn't followed.

### 2. Code Correctness Pass

Review the changed code for correctness issues independent of the plan:

- **Unhandled error paths** — operations that can fail but don't handle failure
- **Logic errors** — wrong conditions, off-by-one, incorrect operator, inverted boolean
- **Race conditions** — shared state without synchronization, async ordering assumptions
- **Resource leaks** — opened but not closed, allocated but not freed, subscribed but not unsubscribed
- **Edge cases** — empty inputs, null/undefined, boundary values, large inputs
- **Security** — injection, unsanitized input, exposed secrets, broken auth checks
- **Dead code or unreachable paths** — code that can never execute

Don't nitpick style. Don't flag things that are technically imperfect but practically fine. Every finding should represent a real risk — something that could cause a bug, a security issue, or a maintenance problem.

### 3. Write the Review

Create `docs/reviews/<topic>.md` following the artifact format below. If the file already exists (a prior review), number it: `<topic>-2.md`, `<topic>-3.md`, etc.

Commit with message: `review: <topic>`

## Artifact Format

```markdown
# Review: [Topic]

**Plan:** `docs/plans/<topic>.md`
**Diff range:** `<pre-implementation-commit>..<current HEAD>`
**Date:** [date]

## Summary

[2-3 sentences. Overall assessment — was the plan implemented faithfully? Are there correctness concerns? Give the reader the headline before the details.]

## Findings

### 1. [Short title]

- **Category:** plan deviation | code correctness
- **Severity:** critical | warning | nit
- **Location:** `path/to/file.ts:42-58`
- **Status:** open

[What's wrong and why it matters. Be specific — reference the plan step if it's a deviation, describe the actual risk if it's a correctness issue. Keep it concise.]

### 2. [Short title]

[...]

...

## No Issues

[If a pass turned up nothing, say so explicitly. "Plan adherence: no significant deviations found." This confirms the pass was run, not skipped.]
```

### Format Rules

- **Summary first** — the reader should know the overall verdict before diving into findings.
- **Findings are numbered sequentially.** Order by severity (critical first), then by category (plan deviations before correctness).
- **Every finding has all five fields** — category, severity, location, status, description. No exceptions.
- **Status is always `open`** when the review is first written. The handle-review skill updates it later to `resolved` or `dismissed`.
- **Severity meanings:**
  - `critical` — likely bug, security issue, or major plan deviation that changes behavior
  - `warning` — potential problem that may cause issues under certain conditions, or meaningful incomplete work
  - `nit` — minor issue, low risk, but worth noting. Use sparingly — if you have more than a few nits, you're being too noisy.
- **Location is specific** — file path and line range. Not just a file name.
- **If there are no findings**, the review file still gets written with an empty findings section and a note confirming both passes were clean.

## Key Principles

- **The plan is the spec** — plan adherence is measured against what the plan said, not what you think it should have said.
- **Judgment over pedantry** — flag what matters, skip what doesn't. Reasonable adaptations during implementation are expected, not defects.
- **Every finding is a real risk** — if you can't articulate why a finding matters, drop it.
- **No fixes, no implementation** — the review produces findings, full stop. Don't fix code, don't suggest rewrites, don't open PRs.
- **Full context, not just the diff** — read the surrounding code to understand whether something is actually wrong or just looks odd in isolation.
- **One shot** — run both passes, write the report, commit. No interactive checkpoints.
