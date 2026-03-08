---
name: handle-review
description: "Act on code review findings — fix what's clearly correct, escalate what's ambiguous. Use after the code-review skill has produced a review file."
---

# Handle Review

## Overview

Take a review file and resolve its findings. Fix everything where both the diagnosis and the fix are unambiguous. Escalate the rest to the user. Do all confident fixes first, then present ambiguous findings as a batch.

This is not a planning skill. Review findings are small and surgical — add missing error handling, fix a logic error, complete an incomplete step. Make the changes directly, commit, and update the review file.

## Process

### 0. Gather Context

1. **Read `codemap.md`** at the repo root. If it doesn't exist, proceed without it.

2. **Read `docs/reviews/<topic>.md`** — the review file. If it doesn't exist, tell the user and stop.

3. **Read `docs/plans/<topic>.md`** — the plan that produced the reviewed code. This gives you the original intent behind each finding.

4. **Read the relevant code.** For each finding, read the file and surrounding context at the location specified. You need to understand the code to judge confidence and make fixes.

### 1. Triage

For each finding that isn't already `resolved` or `dismissed`, assess two things:

- **Is the diagnosis clearly correct?** Is this actually a problem, or could the reviewer be wrong?
- **Is the fix unambiguous?** Is there really only one reasonable way to fix this, or are there trade-offs to weigh?

If both are high confidence → **fix it.**
If either is uncertain → **escalate it.**

Don't overthink the triage. If you hesitate, that's a signal to escalate.

### 2. Fix Confident Findings

For each finding marked to fix:

1. Make the change.
2. Verify it — at minimum, ensure the code compiles / parses. Run relevant tests if they exist.
3. Mark the finding `resolved` in the review file.

After all confident fixes are done, commit everything — code changes and the updated review file — in a single commit. Message: `fix: resolve review findings for <topic>`

### 3. Escalate Ambiguous Findings

If any findings remain unresolved, present them to the user as a batch. For each one, explain:

- What the finding says
- Why you're unsure — is the diagnosis questionable, or is the fix unclear?
- If you're leaning one way, say so

Wait for the user to decide on each. The user may say:

- **Fix it** (with or without guidance on how) → make the fix, mark `resolved`
- **Dismiss it** → mark `dismissed` in the review file
- **Needs a plan** → stop and tell the user this finding is too big for a direct fix. They can take it through the architect → plan → implement pipeline.

After resolving all user decisions, commit the remaining changes and review file updates. Message: `fix: resolve remaining review findings for <topic>`

## Updating the Review File

When marking a finding, update its **Status** field:

- `**Status:** resolved` — the fix was made
- `**Status:** dismissed` — the user decided it's not a real issue

Leave the rest of the finding intact. The review file is a record — don't delete or rewrite findings, just update their status.

## Key Principles

- **Confidence in both diagnosis and fix** — both must be high for autonomous action. If either is uncertain, escalate.
- **When in doubt, escalate** — a wrong fix is worse than asking. Hesitation is a signal.
- **Direct fixes, no plans** — review findings are surgical. If something is big enough to need a plan, escalate it as such.
- **Confident fixes first** — do all the easy wins before pulling the user in. Respect their time.
- **Preserve the review file** — update status fields, don't rewrite history. The review is a record of what was found.
- **Minimal commits** — one commit for confident fixes, one for user-decided fixes. Not one per finding.
