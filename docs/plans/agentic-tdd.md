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

## Steps

**Pre-implementation commit:** `6446016a782ad720bb68cf65bd6b49713e067570`

### Step 1: Rename `skills/planning/` to `skills/impl-planning/`

Rename the directory from `skills/planning/` to `skills/impl-planning/`. Update `SKILL.md` inside:
- Frontmatter: name becomes `impl-planning`, description updated to reference "implementation planning" and note that tests already exist
- Remove the "Follow TDD where it makes sense" paragraph from section 2 (Generate the Plan)
- Add guidance in section 0 (Read the Plan and Codemap) to also read the Tests section and actual test files
- Add to section 2 that steps are planned with awareness of the tests that must pass, and should not include test-writing steps

**Verify:** `skills/impl-planning/SKILL.md` exists, `skills/planning/` does not. Skill name in frontmatter is `impl-planning`. No TDD guidance in the Generate the Plan section. Tests referenced as additional input.
**Status:** done

### Step 2: Create `skills/test-writing/SKILL.md`

New skill file. Should cover:
- **Overview:** Write component-level behavioral tests against architecture interfaces. Also materializes interface definitions as real code.
- **Process:**
  - Read `codemap.md` and the architecture section of `docs/plans/<topic>.md`, focusing on the Interfaces subsection
  - Materialize interface definitions as real code (types, contracts) in appropriate locations per the codemap/architecture
  - Write behavioral/component tests against those interfaces
  - Append a `## Tests` section to the plan file documenting test files created and behaviors covered
  - Commit
- **Test style constraints:** Component boundary behavioral tests only. Happy paths, boundary conditions, error cases. No non-deterministic tests. No internal function tests. No implementation detail testing.
- **Key principle:** The implementation doesn't exist yet — tests can only exercise interfaces, not internals.

**Verify:** `skills/test-writing/SKILL.md` exists with frontmatter name `test-writing`. Covers interface materialization, test writing, and plan file update. Test style constraints are explicit.
**Status:** done

### Step 3: Create `skills/test-review/SKILL.md`

New skill file. Should cover:
- **Overview:** Validate tests against brainstorm intent and architecture. Interactive with the user. Fix issues inline with user approval.
- **Process:**
  - Read brainstorm (`docs/brainstorms/<topic>.md`), architecture + Tests section from `docs/plans/<topic>.md`, and actual test files
  - Validate: test coverage of brainstorm intent, abstraction level, interface-only testing, path coverage (happy/boundary/error), no non-deterministic tests, reasonable expectations
  - Escalate ambiguity to user: missing intent coverage, unexpected test scope, wrong abstraction level, ambiguous expectations
  - Fix issues inline during interactive session with user approval
  - Produce `docs/reviews/<topic>-tests.md` as artifact
  - Stamp plan file Tests section with `**Review status:** approved`
  - Commit

**Verify:** `skills/test-review/SKILL.md` exists with frontmatter name `test-review`. Covers validation criteria, escalation triggers, inline fixing, artifact production, and review stamp.
**Status:** done

### Step 4: Modify `skills/architecting/SKILL.md`

Strengthen the Interfaces guidance:
- In the artifact format's `### Interfaces` section description, emphasize component boundary contracts — what data flows across boundaries, what operations each component exposes, what shapes are expected. Note these must be specific enough for the test writer to materialize as code without making design decisions.
- In the format rules, update the Interfaces bullet to match.
- In Key Principles, add or update the code snippets principle to note that interface descriptions are the primary input for the test-writing phase.

**Verify:** Interfaces section in artifact format and format rules emphasize component boundary specificity. Reference to test-writing phase as downstream consumer is present.
**Status:** done

### Step 5: Modify `skills/implementing/SKILL.md`

Two changes:
- Add a new subsection or bullets in section 0 (Read the Plan and Codemap) noting the Tests section lists immutable test files. The implementer reads the test files but cannot modify them.
- In the verification guidance (sections 1a and 1b), add that running the test suite is a primary success criterion. "Done" means all tests in the Tests section pass.
- Add to section 2 (Handling Reality vs. Plan) or Key Principles: if a test seems unsatisfiable, escalate to the human rather than modifying the test.
- Update references from "planning skill" to "impl-planning skill".

**Verify:** Test immutability constraint is explicit. Test suite as verification criterion is stated. Human escalation for unsatisfiable tests is documented. References say `impl-planning`.
**Status:** done

### Step 6: Update `extensions/workflow/index.ts`

Update all phase-related constants and logic:
- `PHASE_SKILL_MAP`: rename `plan` key to `impl-plan` mapping to `impl-planning`, add `"test-write": "test-writing"` and `"test-review": "test-review"`
- `PHASE_ORDER`: `["brainstorm", "architect", "test-write", "test-review", "impl-plan", "implement", "review", "handle-review", "cleanup"]`
- `FLEXIBLE_TRANSITIONS`: set becomes `["brainstorm", "architect", "test-write", "review"]`
- `PHASE_ARTIFACTS`: add `"test-write": (topic) => "docs/plans/${topic}.md"`, `"test-review": (topic) => "docs/reviews/${topic}-tests.md"`, rename `plan` key to `impl-plan`
- `StringEnum` in the tool parameter: update to include `test-write`, `test-review`, `impl-plan`; remove `plan`

**Verify:** All five constants updated. Phase order is 9 phases. `impl-plan` used consistently instead of `plan`. New phases present in skill map, artifact map, and tool enum. `FLEXIBLE_TRANSITIONS` includes `brainstorm`, `architect`, `test-write`, `review`.
**Status:** done

### Step 7: Update `extensions/workflow/prompt.md`

Update the phase listing to reflect the 9-phase pipeline with correct skill mappings. Update the state inference examples in the "Infer the next phase" bullet to include the new phases.

**Verify:** Prompt lists 9 phases with correct skill mappings. State inference examples reference the new phases.
**Status:** done

### Step 8: Update cross-references in other skills

- `skills/code-review/SKILL.md`: reference to "architecting and planning skills" → "architecting and impl-planning skills"
- `skills/handle-review/SKILL.md`: check for any specific "planning" skill references that need updating

**Verify:** `grep -rn "planning" skills/` shows only `impl-planning` references (in the renamed skill itself and in cross-references). No stale references to the old `planning` skill name.
**Status:** done
