---
name: planning
description: "Turn architectural decisions into concrete, ordered implementation steps. The final phase of the brainstorm → architect → plan pipeline. Appends to the plan the architect started."
---

# Planning

## Overview

Take the architecture in `docs/plans/<topic>.md` and produce concrete, ordered implementation steps. Read the codemap, read the architecture, dive into the relevant code, then write steps specific enough to act on without ambiguity.

The output is the second half of `docs/plans/<topic>.md` — appended below the architecture the architecting skill wrote. The plan file then serves as a living progress tracker during implementation.

Do NOT make new architectural decisions. The architecture is the ceiling — this skill fills in the floor. If something in the architecture doesn't match what you find in the code, stop and surface it to the user rather than silently working around it.

## Process

### 0. Read the Plan and Codemap

Before anything else:

1. **Read `docs/plans/<topic>.md`** — the architecture section written by the architecting skill. This is your scope. If the plan file doesn't exist or has no architecture section, stop and tell the user.

2. **Read `codemap.md`** at the repo root. If it doesn't exist, suggest the user create one using the codemap skill. If they decline, fall back to exploring the codebase directly.

### 1. Investigate

Dive into the code that the architecture references — the impacted modules, the interfaces that will change, the files where work will happen. You need to see the actual code to write steps specific enough to act on. You can't name exact methods, types, and files without looking at what's there.

As you investigate, watch for **misalignment** between the architecture and the codebase. If you find something that contradicts an architectural decision — a module that doesn't exist, an interface shaped differently than assumed, a pattern that conflicts — surface it to the user before proceeding. Don't silently adapt.

### 2. Generate the Plan

Write the full set of implementation steps. Each step should be:

- **Task-level** — names specific files to create or change and what to do in them
- **Unambiguous** — someone (or an agent) could act on it without guessing. "Add a `getSession(id: string): Session | null` method to the `Store` interface in `src/auth/store.ts`", not "add a getter to the store"
- **Ordered correctly** — steps are executed top to bottom. Earlier steps lay foundations that later steps build on. Get the order right.
- **Verifiable** — each step says what "done" looks like

Follow TDD where it makes sense — write the failing test, then make it pass. But don't force test cycles on structural glue: directory setup, export barrels, config changes, dependency additions. Use judgment.

Present the full plan to the user for review before writing it to the file.

### 3. Write the Plan

Append the implementation steps to `docs/plans/<topic>.md` below the architecture section. Follow the artifact format below. Commit with message: `plan: <topic>`

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

- **Steps are numbered sequentially.** Pure linear order — no parallel annotations, no dependency graphs.
- **Each step has a Verify and Status field.** Always. No exceptions.
- **Status values:** `not started`, `in progress`, `done`, `blocked`. Blocked means something unexpected or external is preventing the step — not that a prior step isn't finished.
- **When a step is blocked**, add a note explaining why inline: `**Status:** blocked — waiting on API credentials for the test environment`
- **Step titles are short** — enough to scan the plan and know what each step does without reading the body.
- **Step bodies are specific** — name the files, name the functions, name the types. Reference what you found in the code, not abstractions.


## Key Principles

- **Grounded in code** — steps reference real files, real interfaces, real types found during investigation. Not assumptions.
- **Adds detail, not scope** — the architecture decides what to build. This skill decides the sequence and the specifics. Don't expand beyond the architecture.
- **Generate, don't negotiate** — present the full plan, don't walk through it conversationally. Only surface questions when the architecture doesn't match the code.
- **Get the order right** — since steps are purely linear, the sequence is the dependency graph. A step should never reference something a later step creates.
- **TDD where it fits** — test-first for behavior, not for wiring. Use judgment. Prefer black-box tests that verify observable behavior over white-box tests that couple to implementation details.
- **The plan is a living document** — status fields turn it into a progress tracker during implementation. One artifact from architecture through completion.
- **YAGNI** — don't add steps for things the architecture doesn't call for.
