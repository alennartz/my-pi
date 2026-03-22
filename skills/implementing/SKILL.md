---
name: implementing
description: "Execute an implementation plan — directly for small plans, or by orchestrating module-aligned workers for larger ones. Use when there's a plan ready to build. Requires a plan with steps in docs/plans/<topic>.md — if the plan doesn't exist or has no steps, suggest the planning skill first."
---

# Implementing

## Overview

Take a fully planned `docs/plans/<topic>.md` and execute it. For small plans, work through the steps sequentially yourself. For larger plans, become a phase-level orchestrator: group work by module, spawn workers with inter-agent channels, and manage plan status and commits while workers write the code.

The plan is the source of truth. The architecture section is inviolable. The steps define the scope. Your job is faithful execution with enough judgment to handle the messy reality of code without changing what the plan set out to do.

## Process

### 0. Read the Plan and Codemap

Before touching any code:

1. **Read `codemap.md`** at the repo root. This gives you broad context beyond what the plan references directly.

2. **Read `docs/plans/<topic>.md`** — the full plan: architecture section and steps. If the plan file doesn't exist or has no steps, stop and tell the user. Suggest running the planning skill first (or the architecting skill if no plan file exists at all).

3. **Find your starting point.** Scan the steps for the first one that isn't `done`. Start there. This makes the skill naturally resumable after interruptions or blocks.

### 0.5. Stamp the Starting Commit

If the plan file does not already have a `pre-implementation-commit` field, add one immediately after the `## Steps` heading:

```
**Pre-implementation commit:** `<current HEAD hash>`
```

Use the full 40-character hash. This marks the baseline for code review — everything after this commit is implementation work. Commit this change with the plan file on the first step's commit (don't create a separate commit just for the stamp).

### 0.75. Assess Plan Scope

Estimate the plan's footprint from its steps — how many files are touched, roughly how many lines of change. This is a judgment call, not a hard gate.

- **Small plans** (≤ 5 files, under ~300 lines of change) — proceed with **direct execution** (section 1a). The overhead of spawning workers isn't worth it.
- **Larger plans** — proceed with **orchestrated execution** (section 1b). The primary becomes an orchestrator and never reads source files or writes code directly.

### 1a. Direct Execution

For small plans. Work through each pending step in order:

1. **Mark the step `in progress`** in the plan file.
2. **Do the work.** Write code, create files, make the changes the step describes. Default to pure functions with explicit argument passing. Shared immutable state (config, constants, frozen structures) is fine. If you're about to introduce shared mutable state — even for a micro-design decision the plan didn't address — flag it to the user before proceeding.
3. **Verify.** Run the step's verify check. Layer on cheap smoke checks (compilation, type checking, specific unit tests) as you see fit. Save expensive checks (full test suite, integration tests) for natural breakpoints or the final step.
4. **If verification fails,** try to fix it. Adapt, debug, iterate. If you resolve it, carry on. If you can't — you're going in circles or genuinely stuck — mark the step `blocked` with an explanation, commit that state, and stop.
5. **Mark the step `done`.**
6. **Commit.** Each commit includes the code changes and the updated plan file. Write a real commit message describing what the commit does — not a formulaic template.

### 1b. Orchestrated Execution

For larger plans. The primary orchestrates; workers write code.

1. **Group pending steps by module alignment.** Use the architecture section and codemap to identify which steps touch which modules. Identify inter-step dependencies — where one step's output (an interface, a type, a file) is needed by another.

2. **Spawn a collaborative team.** Create module-aligned workers with channels reflecting dependencies. Each worker gets: its assigned step(s), the relevant file references from the plan, and clear scope boundaries. Workers that depend on each other's outputs get mutual channels so they can share interfaces and types directly.

3. **Workers execute.** Each worker writes code, runs its step's verify check, and sends a completion message to the parent when done. Workers communicate laterally via channels to share interfaces, types, or contracts that unblock peer dependencies. Workers do not edit the plan file or commit. If a worker fails verification or gets stuck, it escalates to the primary via `send`. The primary decides whether to intervene, mark the step `blocked`, or tear down the group — same judgment as the direct path: try to fix it, stop when stuck.

4. **Track progress.** As workers report completions, update plan status fields — mark steps done as they finish. If a worker reports failure and the primary can't resolve it, mark the step `blocked` with an explanation, tear down the group, commit the current state, and stop.

5. **Commit at idle.** When `<group_idle>` fires, the phase is complete. Review the state, run any cross-cutting verification, commit all changes (code + plan updates) together, and decide the next phase.

6. **Slice into phases for control.** On larger plans, don't try to run everything in one group. Slice the work into phases — groups of steps that form a natural unit. After each phase: review, commit, course-correct, engage the user if needed. Phases exist for your own control, not for dependency management (channels handle that).

### 2. Handling Reality vs. Plan

Code doesn't always match what the planner predicted. Navigate mismatches using this hierarchy:

- **Architecture section** — hard constraint. Module boundaries, interfaces, patterns, technology choices. Do not deviate. If reality conflicts with the architecture, stop and surface it to the user. In orchestrated mode, workers escalate architecture conflicts to the primary via `send`, and the primary escalates to the user.
- **Step sequence and scope** — soft constraint. Don't reorder, skip, or add steps without surfacing it to the user. If a step is unnecessary or a new step is clearly needed, say so rather than silently adjusting.
- **Step implementation details** — flexible. Method names are slightly different, a file moved, an extra import is needed, a type is shaped differently than expected. Adapt and keep moving. This is normal.

When in doubt: if you're changing *what* gets done, stop and talk to the user. If you're changing *how* it gets done, use your judgment.

## Key Principles

- **Small plans, direct execution** — if it's ≤ 5 files and under ~300 lines, just do it yourself. Don't over-orchestrate.
- **Large plans, orchestrate** — the primary never reads source files or writes code. Workers do the work; the primary manages flow, plan status, and commits.
- **Workers don't edit the plan or commit** — the primary owns the plan file and the git history. Workers report; the primary records.
- **Channels resolve dependencies, phases are for control** — inter-step dependencies are handled by worker-to-worker communication. The primary slices work into phases for its own ability to review, commit, and course-correct.
- **One shot** — drive through the full plan without stopping for scheduled reviews. Interrupt when you discover something the plan didn't decide — an architecture conflict, a scope change, a design choice that wasn't anticipated. If the plan needs frequent interrupts, the plan is the problem.
- **Architecture is inviolable** — the architecture section is a hard contract. Steps flex; architecture doesn't.
- **Verify early and often** — cheap checks after every step. Expensive checks batched. The plan's verify field is the floor, not the ceiling.
- **Commit per phase** — in direct mode, commit per step. In orchestrated mode, commit when the group goes idle and the phase is complete. Real commit messages.
- **Resumable** — start from the first step that isn't done. Interruptions are cheap.
- **Best effort on errors** — try to fix problems. Stop when stuck, not after a fixed retry count.
- **Don't expand scope** — execute what the plan says. No bonus features, no "while I'm here" refactors.
- **Read only what you need** — the plan and codemap are your primary context. Don't speculatively read files. In orchestrated mode, the primary shouldn't need to read source files at all — that's what workers are for.
- **Pure functions by default** — default to pure functions with explicit argument passing. Shared immutable state is fine. If you're introducing shared mutable state the plan didn't call for, surface it to the user before proceeding.
