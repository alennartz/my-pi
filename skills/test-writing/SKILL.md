---
name: test-writing
description: "Write component-level behavioral tests against architecture interfaces. Use when an architecture exists in docs/plans/<topic>.md with an Interfaces subsection and the next step is to materialize those interfaces as code and write tests before implementation. Produces interface code, test files, and a Tests section in the plan."
disable-model-invocation: true
---

# Test Writing

> **This skill does not pause at the Explore→Act boundary.** The work here is plan execution — proceed through the full process without stopping for confirmation.

> **⛔ DO NOT IMPLEMENT. This phase writes interfaces and failing tests — nothing else.**
> You are forbidden from writing any working logic: no function bodies that compute a
> result, no parsing, splitting, branching business rules, or algorithms — even if the
> logic is "obvious" or "one line." Interface bodies are stubs that `throw new Error("not
> implemented")` (or return a trivially-typed nullish value only where a throw won't
> compile). **If, at the end of this phase, any new test passes, you have failed the
> phase** — you wrote implementation that must not exist yet. See the Red Gate (step 2.5).

## Overview

Turn architecture interfaces into real code and write behavioral tests against them — before any implementation exists. Read the architecture's Interfaces subsection, materialize the type definitions and contracts as committed code, then write component-level tests that exercise those interfaces.

The output is threefold: interface definition code in the codebase, test files in the codebase, and a `## Tests` section appended to `docs/plans/<topic>.md` documenting what was created. The implementation doesn't exist yet — tests can only exercise interfaces, not internals.

## Process

### 0. Gather Context

1. **Read `codemap.md`** at the repo root. Use it to understand module boundaries, file ownership, and where new code should live.

2. **Read `docs/plans/<topic>.md`** — the full plan through the Architecture section. Focus on the **Interfaces** subsection: data shapes, operations exposed, contracts between components. If the plan doesn't exist or has no Architecture section, tell the user and stop — suggest running the architecting skill first.

3. **Read existing code** around the interfaces being defined. Understand current type conventions, file organization patterns, and import styles so the materialized interfaces fit naturally.

### 0.5. Stamp the Starting Commit

Record the current HEAD hash before making any changes. This becomes the `pre-test-write-commit` baseline — code review uses it to scope its diff back to before any test infrastructure existed. You'll write this hash into the `## Tests` section in step 3.

### 1. Materialize Interfaces

Turn the architecture's interface descriptions into real code — types, contracts, data shapes, API boundaries. These are the public surfaces that tests will exercise and the implementation will later satisfy.

- **Place files according to the codemap and architecture.** If the architecture specifies where interfaces live, follow it. Otherwise, use the codemap's module structure and existing conventions.
- **Only define interfaces, not implementations.** Types, abstract contracts, data shapes, error types, enums — the structural skeleton. No function bodies that compute a result, no business logic, no algorithms.
  - **A stub is a body that does nothing real.** For any function the plan asks you to create, the body is `throw new Error("not implemented")` — or, only where a throw won't type-check (e.g. a value the compiler requires), the cheapest trivially-typed nullish value. A stub NEVER parses, splits, branches on inputs, loops, or derives an output from an argument.
  - **DO NOT write, even when it's tempting:** the "obvious" one-liner, the "trivial" string split, the "simple" validation check, the "just a map lookup." If it turns an input into a meaningful output, it is implementation and it belongs to a later phase. Writing it here is the exact failure this phase guards against.
- **Match the codebase's style.** Follow existing naming conventions, export patterns, and file organization.
- **Alter existing code when necessary — structurally, not behaviorally.** Introducing new interfaces into a live codebase often requires touching existing files — changing imports, adjusting type signatures, updating call sites to reference new stubs, adding stub exports. Do the minimal *structural* work needed so the project compiles. "Make it compile" is NOT license to make it *work*: never satisfy a compile error by writing real logic. If a call site now needs a value the stub can't yet produce, wire it to the stub and let the test fail — that failure is the point.
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

### 2.5. Red Gate — Verify the Tests Fail

**Mandatory. Do not skip. Do not commit before this passes.**

Run the test suite and inspect the result for the tests you just wrote:

- **Every new test MUST fail** (assertion failure or `"not implemented"` throw). A new test that fails to *compile* or crashes the runner is not acceptable either — the suite must launch and execute; the new tests must run and go red.
- **If any new test PASSES, the phase has failed.** A green new test means a stub already returns the value the test expects — i.e. you wrote implementation. Find the logic that made it pass, replace it with a `throw new Error("not implemented")` stub, and re-run until the test is red. Repeat until zero new tests pass.
- Pre-existing tests unrelated to this topic should stay green; only tests you added/altered for this topic are expected to be red.

The Red Gate is the objective check that this phase stayed inside its boundary. Passing it (all new tests red) is a precondition for committing.

### 3. Document and Commit

Append a `## Tests` section to `docs/plans/<topic>.md` following the artifact format below.

Commit all changes (interface code, test files, plan update) with message: `test-write: <topic>`

## Artifact Format

The `## Tests` section appended to the plan file:

```markdown
## Tests

**Pre-test-write commit:** `<full 40-character HEAD hash>`

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
- **Pre-test-write commit** — the HEAD hash captured in step 0.5. Code review uses this as its diff baseline to scope the review back through test writing.
- **No review status yet.** The test-review skill adds the review stamp later. Don't include it here.

## Key Principles

- **Interfaces first, tests second** — materialize the architecture's interfaces as real code before writing any tests. Tests import and exercise these interfaces.
- **The implementation doesn't exist yet — but the code must compile.** Tests should be writable and understandable without real implementation logic. But you're working in a live codebase, not a vacuum. If introducing new interfaces requires minimal changes to existing code — stub functions, updated imports, type adjustments, thin adapter wiring — make them. The bar is: the project compiles, the test runner launches and executes, and you haven't written real business logic. New tests failing is expected. Existing tests failing because you changed their interface surface is acceptable. The application crashing at startup is acceptable — you're not trying to keep it running, just compilable and testable. Compile errors or test runner crashes are not acceptable.
- **Component boundaries, not internals** — test what crosses a boundary. Inputs, outputs, observable effects. Never reach inside. The **codebase-design** skill supplies the vocabulary and the rule: the interface is the test surface — a test that must reach past it means the module is the wrong shape, which is a finding for the architecture, not a license to test internals.
- **The architecture is the spec** — tests validate the behavioral contracts described in the architecture. Don't invent requirements the architecture doesn't describe. Don't skip requirements it does describe.
- **Fit the codebase** — follow existing test frameworks, file conventions, and style. Don't introduce new test infrastructure unless the architecture calls for it.
