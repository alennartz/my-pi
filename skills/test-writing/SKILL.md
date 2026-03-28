---
name: test-writing
description: "Write component-level behavioral tests against architecture interfaces. Use when an architecture exists in docs/plans/<topic>.md with an Interfaces subsection and the next step is to materialize those interfaces as code and write tests before implementation. Produces interface code, test files, and a Tests section in the plan."
---

# Test Writing

## Overview

Turn architecture interfaces into real code and write behavioral tests against them — before any implementation exists. Read the architecture's Interfaces subsection, materialize the type definitions and contracts as committed code, then write component-level tests that exercise those interfaces.

The output is threefold: interface definition code in the codebase, test files in the codebase, and a `## Tests` section appended to `docs/plans/<topic>.md` documenting what was created. The implementation doesn't exist yet — tests can only exercise interfaces, not internals.

## Process

### 0. Gather Context

1. **Read `codemap.md`** at the repo root. Use it to understand module boundaries, file ownership, and where new code should live.

2. **Read `docs/plans/<topic>.md`** — the full plan through the Architecture section. Focus on the **Interfaces** subsection: data shapes, operations exposed, contracts between components. If the plan doesn't exist or has no Architecture section, tell the user and stop — suggest running the architecting skill first.

3. **Read existing code** around the interfaces being defined. Understand current type conventions, file organization patterns, and import styles so the materialized interfaces fit naturally.

### 1. Materialize Interfaces

Turn the architecture's interface descriptions into real code — types, contracts, data shapes, API boundaries. These are the public surfaces that tests will exercise and the implementation will later satisfy.

- **Place files according to the codemap and architecture.** If the architecture specifies where interfaces live, follow it. Otherwise, use the codemap's module structure and existing conventions.
- **Only define interfaces, not implementations.** Types, abstract contracts, data shapes, error types, enums — the structural skeleton. No function bodies, no business logic, no algorithms.
- **Match the codebase's style.** Follow existing naming conventions, export patterns, and file organization.
- **Alter existing code when necessary.** Introducing new interfaces into a live codebase often requires touching existing files — changing imports, adjusting type signatures, updating call sites, adding stub exports. Do whatever minimal work is needed so the project compiles with the new interfaces in place. This isn't implementation — it's integration scaffolding.
- **Existing tests may need updating too.** If your interface changes break existing tests at the type or import level, fix them enough to compile. Don't rewrite their logic — just keep them structurally valid against the new interfaces.

### 2. Write Tests

Write component-level behavioral tests against the materialized interfaces.

- **One test file per component boundary** unless the architecture suggests a different grouping. Place test files following the project's existing test conventions (co-located, `__tests__/`, `tests/`, etc.). If no convention exists, co-locate with the interface files.
- **Cover the behavioral surface:**
  - **Happy paths** — the expected usage patterns described in the architecture
  - **Boundary conditions** — empty inputs, maximum sizes, type edges, zero/null cases
  - **Error cases** — invalid inputs, missing required data, contract violations, expected failure modes
- **Name tests descriptively.** Each test name should read as a behavioral assertion: what the component does under what conditions, not what internal function is called.
- **The project must build and tests must run.** By the end of this phase, the full project compiles and the test suite executes. New tests will fail (no implementation yet) and altered existing tests may also fail — that's expected. But nothing should fail to *compile*, and the test suite must *launch and run*. The application itself crashing at startup is fine — that's not the bar. If getting there requires stub functions that throw `"not implemented"`, minimal adapter code, or trivial wiring changes to existing modules, do it.

### Test Style Constraints

These are hard rules, not guidelines:

- **Component boundary tests only.** Test the public surface — what goes in, what comes out, what side effects are observable. Never test internal functions, private methods, or implementation details.
- **No non-deterministic tests.** No timers, no random values, no network calls, no filesystem races. If a behavior involves non-determinism, test the deterministic contract around it (e.g., "accepts a random seed and produces consistent output" rather than "produces random output").
- **No implementation detail testing.** The implementation doesn't exist yet. Tests exercise interfaces — defined inputs, expected outputs, documented contracts. If a test would need to know *how* something is implemented to pass, it's wrong.
- **Reasonable expectations.** Test expectations should be satisfiable by any correct implementation of the interface. Don't over-specify return value shapes beyond what the interface defines. Don't assert on internal state.

### 3. Document and Commit

Append a `## Tests` section to `docs/plans/<topic>.md` following the artifact format below.

Commit all changes (interface code, test files, plan update) with message: `test-write: <topic>`

## Artifact Format

The `## Tests` section appended to the plan file:

```markdown
## Tests

### Interface Files

- `path/to/interfaces.ts` — [brief description of what interfaces are defined]
- ...

### Test Files

- `path/to/component.test.ts` — [brief description of what behaviors are tested]
- ...

### Behaviors Covered

[Bulleted list of the key behaviors under test, grouped by component. Each bullet should map to a test or small group of tests. This is the behavioral contract the implementation must satisfy.]

#### [Component Name]

- [Behavior description — what it does, under what conditions]
- [Another behavior]
- ...
```

### Format Rules

- **Interface Files** — list every file created or modified to materialize interfaces. Brief description of contents.
- **Test Files** — list every test file created. Brief description of what behavioral surface it covers.
- **Behaviors Covered** — grouped by component. Each bullet is a behavioral assertion, not a test function name. Written so a reader can understand what the implementation must do without reading the test code.
- **No review status yet.** The test-review skill adds the review stamp later. Don't include it here.

## Key Principles

- **Interfaces first, tests second** — materialize the architecture's interfaces as real code before writing any tests. Tests import and exercise these interfaces.
- **The implementation doesn't exist yet — but the code must compile.** Tests should be writable and understandable without real implementation logic. But you're working in a live codebase, not a vacuum. If introducing new interfaces requires minimal changes to existing code — stub functions, updated imports, type adjustments, thin adapter wiring — make them. The bar is: the project compiles, the test runner launches and executes, and you haven't written real business logic. New tests failing is expected. Existing tests failing because you changed their interface surface is acceptable. The application crashing at startup is acceptable — you're not trying to keep it running, just compilable and testable. Compile errors or test runner crashes are not acceptable.
- **Component boundaries, not internals** — test what crosses a boundary. Inputs, outputs, observable effects. Never reach inside.
- **The architecture is the spec** — tests validate the behavioral contracts described in the architecture. Don't invent requirements the architecture doesn't describe. Don't skip requirements it does describe.
- **Fit the codebase** — follow existing test frameworks, file conventions, and style. Don't introduce new test infrastructure unless the architecture calls for it.
