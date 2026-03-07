# Brainstorm: Implementation Skill

## The Idea

A skill that completes the brainstorm → architect → plan → **implement** pipeline. Takes a fully planned `docs/plans/<topic>.md` file and executes the steps, turning the plan into working code.

## Key Decisions

### Execution model: one-shot, not conversational

The agent executes all steps sequentially without human checkpoints. The premise is that if the plan is good enough (and scoped to a reasonable size), it should be executable in one shot. If it isn't, that's a planning problem, not an implementation problem.

### Rigidity hierarchy

Not everything in the plan has equal weight:

- **Architecture section** — hard constraint. Module boundaries, interfaces, patterns. No deviation.
- **Step sequence and scope** — soft constraint. Don't reorder, skip, or add steps without surfacing to the user.
- **Step implementation details** — flexible. The agent adapts the *how* when reality doesn't match what the planner predicted (different method names, moved files, extra imports).

The architecture is the contract. The steps are the route. The details are tactical.

### Verification strategy: cheap checks often, expensive checks less so

The plan's `Verify` field on each step is the floor, not the ceiling. The agent can always do more. The principle is:

- **After every step:** run the step's verify plus cheap smoke checks (compilation, specific unit tests, file existence).
- **Less frequently:** expensive checks (full test suite, integration tests) at natural breakpoints or at the end.

The agent uses its own judgment on what's cheap vs expensive. No formal rules — just the principle of early and often for cheap, batched for expensive.

### Commits: per step, with status updates

Each step gets its own commit containing the code changes and the status update in the plan file. Commit messages are descriptive — real commit messages, not formulaic like the other skills. The plan file is part of every commit, making each one self-documenting.

### Resumable via status fields

The skill scans the plan for the first step that isn't `done` and starts there. This makes it naturally resumable after interruptions or blocks.

### Error handling: best effort, then stop

No formal retry protocol. The agent does its best to resolve issues — if a verify fails, it tries to fix it. If it's going in circles or hits something it genuinely can't resolve, it stops, marks the step `blocked` with an explanation in the plan file, and commits that state.

### Reads the codemap at start

Even though the plan already names specific files and functions, the codemap gives broader context that helps the agent make better judgment calls when adapting.

## Direction

The implementation skill:

1. Reads `codemap.md` and `docs/plans/<topic>.md`
2. Finds the first step that isn't `done`
3. Executes each step sequentially — writing code, running verifications, committing per step
4. Updates status fields in the plan file as it goes
5. Adapts step-level details to reality but holds the architecture as inviolable
6. Stops and marks `blocked` when it can't resolve an issue
7. Hands off to a future code review skill when done

## Open Questions

- **Code review skill** — implementation deliberately stops at "code is written and tests pass." Code review is a separate skill yet to be designed.
