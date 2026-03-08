---
name: implementing
description: "Execute a plan by working through its steps sequentially — writing code, verifying, and committing. The final phase of the brainstorm → architect → plan → implement pipeline."
---

# Implementing

## Overview

Take a fully planned `docs/plans/<topic>.md` and execute it. Work through the steps sequentially, writing code, running verifications, committing per step, and updating status fields as you go. One shot — no human checkpoints.

The plan is the source of truth. The architecture section is inviolable. The steps define the scope. Your job is faithful execution with enough judgment to handle the messy reality of code without changing what the plan set out to do.

## Process

### 0. Read the Plan and Codemap

Before touching any code:

1. **Read `codemap.md`** at the repo root. This gives you broad context beyond what the plan references directly.

2. **Read `docs/plans/<topic>.md`** — the full plan: architecture section and steps. If the plan file doesn't exist or has no steps, stop and tell the user.

3. **Find your starting point.** Scan the steps for the first one that isn't `done`. Start there. This makes the skill naturally resumable after interruptions or blocks.

### 0.5. Stamp the Starting Commit

If the plan file does not already have a `pre-implementation-commit` field, add one immediately after the `## Steps` heading:

```
**Pre-implementation commit:** `<current HEAD hash>`
```

Use the full 40-character hash. This marks the baseline for code review — everything after this commit is implementation work. Commit this change with the plan file on the first step's commit (don't create a separate commit just for the stamp).

### 1. Execute Each Step

For each step, in order:

1. **Mark the step `in progress`** in the plan file.
2. **Do the work.** Write code, create files, make the changes the step describes.
3. **Verify.** Run the step's verify check. Layer on cheap smoke checks (compilation, type checking, specific unit tests) as you see fit. Save expensive checks (full test suite, integration tests) for natural breakpoints or the final step.
4. **If verification fails,** try to fix it. Adapt, debug, iterate. If you resolve it, carry on. If you can't — you're going in circles or genuinely stuck — mark the step `blocked` with an explanation, commit that state, and stop.
5. **Mark the step `done`.**
6. **Commit.** Each commit includes the code changes and the updated plan file. Write a real commit message describing what the commit does — not a formulaic template.

### 2. Handling Reality vs. Plan

Code doesn't always match what the planner predicted. Navigate mismatches using this hierarchy:

- **Architecture section** — hard constraint. Module boundaries, interfaces, patterns, technology choices. Do not deviate. If reality conflicts with the architecture, stop and surface it to the user.
- **Step sequence and scope** — soft constraint. Don't reorder, skip, or add steps without surfacing it to the user. If a step is unnecessary or a new step is clearly needed, say so rather than silently adjusting.
- **Step implementation details** — flexible. Method names are slightly different, a file moved, an extra import is needed, a type is shaped differently than expected. Adapt and keep moving. This is normal.

When in doubt: if you're changing *what* gets done, stop and talk to the user. If you're changing *how* it gets done, use your judgment.

## Key Principles

- **One shot** — execute the full plan without human checkpoints. If the plan isn't good enough for that, the plan is the problem.
- **Architecture is inviolable** — the architecture section is a hard contract. Steps flex; architecture doesn't.
- **Verify early and often** — cheap checks after every step. Expensive checks batched. The plan's verify field is the floor, not the ceiling.
- **Commit per step** — every step gets its own commit with code changes and status update. Real commit messages.
- **Resumable** — start from the first step that isn't done. Interruptions are cheap.
- **Best effort on errors** — try to fix problems. Stop when stuck, not after a fixed retry count.
- **Don't expand scope** — execute what the plan says. No bonus features, no "while I'm here" refactors.
- **Read only what you need** — the plan and codemap are your primary context. Don't speculatively read files for background or "while I'm here" exploration. If a step references a file or pattern, read it. If you discover mid-step that you're missing information, read then. Unnecessary reads bloat context and waste tokens.
