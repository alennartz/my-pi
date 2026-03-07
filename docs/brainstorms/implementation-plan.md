# Brainstorm: Implementation Plan Skill

## The Idea

A skill that takes the architectural decisions in `docs/plans/<topic>.md` and adds concrete, ordered implementation steps below them. The final skill in the brainstorm → architect → implement pipeline. Turns "what the architecture looks like" into "what to do, in what order."

## Key Decisions

### Steps are task-level, specific to files and changes
- Each step names the specific files to create or change and what to do in them
- Specific enough to act on without ambiguity — "Add a `getSession(id: string)` method to the `Store` interface in `src/auth/store.ts`", not "add a getter to the store interface"
- The skill reads code (not just the architecture and codemap) to get to this level of specificity

### Pure linear sequence
- Steps are numbered sequentially and executed in order
- No parallel annotations, no dependency graphs — the agent's job is to get the order right
- Simple mental model: do step 1, then step 2, then step 3

### The plan file is a living progress tracker
- Each step has a `Status:` field that gets updated during implementation
- Status values: `not started`, `in progress`, `done`, `blocked`
- `blocked` means something unexpected or external is preventing the step — not that a prior step isn't finished (the linear sequence handles that)
- The plan file serves as the single source of truth for what's been done and what's left

### Step format

```markdown
### Step N: [Short title]

[What to do, which files, what changes]

**Verify:** [How to confirm it's done — test passes, command output, etc.]
**Status:** not started
```

### Not conversational — generate and present
- The agent generates the full plan and presents it for review
- No step-by-step negotiation — the architectural decisions are already made
- The agent only surfaces questions if it discovers that the architecture doesn't align with what it finds in the codebase during exploration

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

### Final step is always a codemap update
- The last step in every plan is to update `codemap.md` to reflect the changes made during implementation
- The codemap reflects reality, so it gets updated after the work is done, not before

### No phases
- Plans are a flat numbered list even when large
- No grouping layer above individual steps

## Direction

Build an implementation plan skill that reads the architecture section of `docs/plans/<topic>.md`, the codemap, and relevant source code, then appends concrete, ordered implementation steps to the same plan file. Steps are task-level (specific files and changes), numbered in a pure linear sequence. Each step has a status field so the plan doubles as a progress tracker during implementation. The agent generates the full plan without conversation, only surfacing questions if the architecture doesn't match codebase reality. TDD is the default approach where it makes sense, with verification criteria for each step. The final step is always a codemap update. The skill adds detail but not scope — it realizes the architecture, it doesn't expand it.

## Open Questions

None — ready to build.
