# Brainstorm: Implementation Plan Skill

## The Idea

A skill that takes the architectural decisions in `docs/plans/<topic>.md` and adds concrete, ordered implementation steps below them. The final skill in the brainstorm → architect → implement pipeline. Turns "what the architecture looks like" into "what to do, in what order."

## Key Decisions

### Steps are task-level, specific to files and changes
- Each step names the specific files to create or change and what to do in them
- Specific enough to act on without ambiguity — "Add a `getSession(id: string)` method to the `Store` interface in `src/auth/store.ts`", not "add a getter to the store interface"
- The skill reads code (not just the architecture and codemap) to get to this level of specificity

### Linear sequence with concurrency annotations
- Steps are numbered sequentially — the default reading is "do these in order"
- When steps can be done concurrently, a simple note says so (e.g., "Steps 3-4 can be done in parallel")
- No dependency graphs or module-grouped plans — the architecture already organizes by module, the implementation plan organizes by sequence

### Adds detail, not scope
- The architecture is the ceiling — the implementation plan fills in the floor
- No new architectural decisions, no scope creep
- Gets more concrete than the architecture but stays within its boundaries

### TDD as default posture, not rigid rule
- Steps follow red-green-refactor when it makes sense — write the failing test, make it pass, clean up
- Not every step warrants a test cycle — structural glue (directory setup, export barrels, dependency additions) doesn't need forced TDD
- The agent exercises judgment about when TDD applies
- Verification before claiming completion — each step should make it clear what "done" looks like

### Reads code to get concrete
- The skill reads the codemap and architecture, but also dives into the actual code
- Necessary to write steps specific enough to act on — you can't name exact methods, interfaces, and files without looking at what's there

### Completes the same artifact the architect started
- Appends to `docs/plans/<topic>.md` below the architecture section
- Single document captures both the shape and the sequence

## Direction

Build an implementation plan skill that reads the architecture section of `docs/plans/<topic>.md`, the codemap, and relevant source code, then appends concrete, ordered implementation steps to the same plan file. Steps are task-level (specific files and changes), numbered sequentially with concurrency noted where possible. TDD is the default approach where it makes sense, with verification criteria for each step. The skill adds detail but not scope — it realizes the architecture, it doesn't expand it.

## Open Questions

None — ready to build.
