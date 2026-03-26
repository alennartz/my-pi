---
name: planning
description: "Turn a direction into concrete, ordered implementation steps grounded in the codebase. Use when the user wants a step-by-step plan for building something. Requires architectural decisions in docs/plans/<topic>.md — if those don't exist, suggest the architecting skill first."
---

# Planning

## Overview

Take the architecture in `docs/plans/<topic>.md` and produce concrete, ordered implementation steps. Read the codemap, read the architecture, dive into the relevant code, then write steps specific enough to act on without ambiguity.

The output is the second half of `docs/plans/<topic>.md` — appended below the architecture the architecting skill wrote. The plan file then serves as a living progress tracker during implementation.

Do NOT make new architectural decisions. The architecture is the ceiling — this skill fills in the floor. If something in the architecture doesn't match what you find in the code, stop and surface it to the user rather than silently working around it.

## Process

### 0. Read the Plan and Codemap

Before anything else:

1. **Read `docs/plans/<topic>.md`** — the architecture section written by the architecting skill. This is your scope. If the plan file doesn't exist or has no architecture section, stop and tell the user. Suggest running the architecting skill first to establish the architectural decisions this skill builds on.

2. **Read `codemap.md`** at the repo root. If it doesn't exist, suggest the user create one using the codemap skill. If they decline, fall back to exploring the codebase directly.

### 1. Investigate

Scout the code that the architecture references — the impacted modules, the interfaces that will change, the files where work will happen.

As you investigate, watch for **misalignment** between the architecture and the codebase. If you find something that contradicts an architectural decision — a module that doesn't exist, an interface shaped differently than assumed, a pattern that conflicts — surface it to the user before proceeding. Don't silently adapt.

### 2. Generate the Plan

Write the full set of implementation steps. Each step should be:

- **Task-level** — names specific files to create or change and what to do in them
- **Unambiguous** — someone (or an agent) could act on it without guessing. "Add a `getSession(id: string): Session | null` method to the `Store` interface in `src/auth/store.ts`", not "add a getter to the store"
- **Ordered correctly** — steps are executed top to bottom. Earlier steps lay foundations that later steps build on. Get the order right.
- **Verifiable** — each step says what "done" looks like

Follow TDD where it makes sense — write the failing test, then make it pass. But don't force test cycles on structural glue: directory setup, export barrels, config changes, dependency additions. Use judgment.

**Code snippets in steps** — use code when it communicates shape more clearly than prose: interfaces, type signatures, data structures, important function signatures. These help the implementer understand boundaries and contracts without ambiguity. Avoid implementation snippets — function bodies, algorithms, control flow — because they pre-empt TDD and over-constrain how the implementer solves the problem. The step should describe *what* the code needs to look like at its boundaries, not *how* it works internally. When prose is equally clear, prefer prose.

**Pure functions by default** — design data flow through explicit argument passing and pure functions. Shared immutable state (config loaded once, constants, frozen data structures) is fine and needs no special treatment. If a step's design requires shared *mutable* state, surface the decision to the user with reasoning before writing it into the step.

Present the full plan to the user for review before writing it to the file.

### 3. Write the Plan

Append the implementation steps to `docs/plans/<topic>.md` below the architecture section. Follow the artifact format below.

### 4. Check for Blind Spots

If `docs/brainstorms/<topic>.md` exists, spawn a default subagent with the brainstorm and plan file paths. Its task: read both files and identify brainstorm intent that the plan steps don't cover. Each gap should name the missing intent and explain why existing steps don't address it.

Wait for `<agent_complete>`. Review the output — filter noise (intent already covered, or out of scope) and surface substantive findings to the user. The user decides per finding: add a step (next sequential number, `not started` status) or dismiss. Update the plan file if steps were added.

If no brainstorm exists, skip the check.

Commit with message: `plan: <topic>`

## Artifact Format

The steps are appended below the existing architecture section:

```markdown
## Steps

### Step 1: [Short title]

[What to do, which files, what changes. Specific enough to act on.]

**Verify:** [How to confirm it's done — test passes, command output, behavior, etc.]
**Status:** not started

### Step 2: [Short title]

[...]

**Verify:** [...]
**Status:** not started

...
```

### Format Rules

- **Steps are numbered sequentially.** Numbering reflects natural authoring and build order, not a concurrency constraint. The implementer decides how to batch and parallelize at runtime.
- **Each step has a Verify and Status field.** Always. No exceptions.
- **Status values:** `not started`, `in progress`, `done`, `blocked`. Blocked means something unexpected or external is preventing the step — not that a prior step isn't finished.
- **When a step is blocked**, add a note explaining why inline: `**Status:** blocked — waiting on API credentials for the test environment`
- **Step titles are short** — enough to scan the plan and know what each step does without reading the body.
- **Step bodies are specific** — name the files, name the functions, name the types. Reference what you found in the code, not abstractions.


## Key Principles

- **Grounded in code** — steps reference real files, real interfaces, real types found during investigation. Not assumptions.
- **Adds detail, not scope** — the architecture decides what to build. This skill decides the sequence and the specifics. Don't expand beyond the architecture.
- **Generate, don't negotiate** — present the full plan, don't walk through it conversationally. Only surface questions when the architecture doesn't match the code.
- **Get the order right** — earlier steps should lay foundations for later steps. This is good authoring practice and gives the implementer a natural build sequence, but it's not a strict concurrency constraint — the implementer may parallelize steps that touch independent modules.
- **TDD where it fits** — test-first for behavior, not for wiring. Use judgment. Prefer black-box tests that verify observable behavior over white-box tests that couple to implementation details.
- **The plan is a living document** — status fields turn it into a progress tracker during implementation. One artifact from architecture through completion.
- **YAGNI** — don't add steps for things the architecture doesn't call for.
- **Code snippets for shape, not implementation** — use code in steps when it clarifies interfaces, types, or signatures better than prose. Avoid implementation snippets that pre-empt TDD or over-constrain the implementer.
- **Pure functions by default** — design data flow through explicit argument passing and pure functions. Shared immutable state is fine. Shared *mutable* state requires surfacing the decision to the user with reasoning before writing it into a step.
