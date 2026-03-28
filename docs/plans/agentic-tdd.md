# Plan: Agentic TDD

## Context

Integrating TDD into the workflow pipeline by separating test writing from implementation through context boundaries and a test review checkpoint. Tests are written against architecture interfaces before implementation planning begins, ensuring independent behavioral validation. See [docs/brainstorms/agentic-tdd.md](../brainstorms/agentic-tdd.md).

## Architecture

### Impacted Modules

**Workflow**

The pipeline expands from 7 to 9 phases. The extension's phase definitions (`PHASE_ORDER`, `PHASE_SKILL_MAP`, `FLEXIBLE_TRANSITIONS`, `PHASE_ARTIFACTS`) all change. The prompt template lists the new phases. Artifact inventory scanning in `phases.ts` is unaffected — it already scans `docs/plans/`, `docs/brainstorms/`, and `docs/reviews/`.

The `plan` phase is renamed to `impl-plan` throughout — phase constants, skill mapping, prompt template. The `planning` skill is renamed to `impl-planning`. Two new phases are inserted between `architect` and `impl-plan`: `test-write` and `test-review`.

New pipeline order: `brainstorm → architect → test-write → test-review → impl-plan → implement → review → handle-review → cleanup`

Context boundary changes:
- `architect → test-write` — flexible (user chooses same context or clean)
- `test-write → test-review` — mandatory clean context
- `test-review → impl-plan` — mandatory clean context
- `impl-plan → implement` — mandatory clean context (unchanged behavior)

State inference for the new phases uses the plan file (`docs/plans/<topic>.md`):
- Architecture section exists, no Tests section → next phase is test-write
- Tests section exists, not reviewed → next phase is test-review
- Tests section reviewed, no Steps section → next phase is impl-plan

Test review produces `docs/reviews/<topic>-tests.md` as its artifact, following the same pattern as code review.

**Skills (standalone)**

No changes. Decision records, codemap, and debugging skills are unaffected.

### New Modules

**test-writing skill** (`skills/test-writing/SKILL.md`)

Owns the test-write phase. Reads the architecture section of `docs/plans/<topic>.md` — specifically the Interfaces subsection — and the codemap. Materializes interface definitions as real code (types, contracts) and writes component-level behavioral tests against them. Produces:
1. Interface definition code committed to the codebase
2. Test files committed to the codebase
3. A `## Tests` section appended to `docs/plans/<topic>.md` documenting what was created (files, behaviors covered)

Test style constraints baked into the skill:
- Component boundary behavioral tests — test public surfaces, not internals
- Cover happy paths, boundary conditions, and error cases
- No non-deterministic tests
- No implementation detail testing (the implementation doesn't exist yet)

**test-review skill** (`skills/test-review/SKILL.md`)

Owns the test-review phase. Reads brainstorm (`docs/brainstorms/<topic>.md`), architecture section and Tests section of the plan file, and the actual test files. Interactive with the user.

Validates:
- Tests cover behaviors described in the brainstorm's direction and key decisions
- Tests are at the right abstraction level (component boundary, not internal)
- Tests exercise the defined interfaces, not hypothetical internals
- Happy paths, boundary conditions, and error cases are represented
- No non-deterministic tests
- Test expectations are reasonable and implementable

Escalates to the user:
- Brainstorm intent that no test covers
- Tests that cover something the brainstorm didn't ask for
- Tests at too low an abstraction level
- Ambiguous expectations

Fixes issues inline during the interactive session with user approval. Produces `docs/reviews/<topic>-tests.md` as artifact. Stamps the plan file's Tests section as reviewed.

### Interfaces

**Plan file structure** (`docs/plans/<topic>.md`) expands:

```
## Context
## Architecture
  ### Impacted Modules
  ### Interfaces          ← strengthened: thorough component boundary contracts
  ...
## Tests                  ← NEW: added by test-write phase
  ### Test Files
  ### Behaviors Covered
  **Review status:** approved   ← stamped by test-review phase
## Steps                  ← added by impl-plan phase (formerly plan phase)
```

**Test review artifact** (`docs/reviews/<topic>-tests.md`) follows the same structure as code review findings — list of findings with severity, resolution status. Written by the test-review skill at phase completion.

**Skill-to-extension interface** is unchanged — skills call `workflow_phase_complete` with topic and phase name. The extension handles transitions. New phase names (`test-write`, `test-review`, `impl-plan`) are added to the valid phase enum.

### DR Supersessions

- **DR-002** (Three-Phase Design Pipeline — Brainstorm, Architect, Plan) — superseded because the pipeline now has five design phases instead of three. New decision: five-phase design pipeline (brainstorm, architect, test-write, test-review, impl-plan) with the same shared artifact pattern (`docs/plans/<topic>.md`). Each phase has a clear scope ceiling. The brainstorm explores intent, the architect makes structural decisions with emphasis on component boundary interfaces, the test writer materializes interfaces and writes behavioral tests, the test reviewer validates tests against intent, and the impl-planner produces implementation steps aware of the tests that must pass.

### Skill Modifications

**architecting skill** (`skills/architecting/SKILL.md`)

The Interfaces subsection of the architecture output needs stronger emphasis on component boundary contracts. The architecture is the last design phase before the test writer takes over (potentially in a clean context), so interface descriptions must be specific enough that the test writer can materialize them as code without making design decisions. Data shapes, operations exposed, contracts between components — described in prose and pseudocode, not committed code, but thorough.

**impl-planning skill** (`skills/impl-planning/SKILL.md`, renamed from `skills/planning/SKILL.md`)

Two changes:
- Reads the Tests section and actual test files as additional input. Implementation steps are planned with awareness of what behavioral expectations must be satisfied.
- Removes the "Follow TDD where it makes sense" guidance. Tests already exist. Steps are purely about making them pass.

**implementing skill** (`skills/implementing/SKILL.md`)

Two changes:
- Tests are immutable. Test files listed in the plan's Tests section cannot be modified by the implementer. If a test seems unsatisfiable, the implementer escalates to the human.
- The verification loop includes running the test suite as a primary success criterion. "Done" means tests pass.
