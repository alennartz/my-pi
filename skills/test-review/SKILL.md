---
name: test-review
description: "Validate tests against brainstorm intent and architecture. Use when tests have been written in the test-write phase and need checking before implementation planning begins. Interactive — escalates ambiguity to the user and fixes issues inline with approval. Produces docs/reviews/<topic>-tests.md."
---

# Test Review

## Overview

Validate that the tests written in the test-write phase actually cover the brainstorm's intent and respect the architecture's boundaries. This is an interactive review — walk through the tests with the user, escalate gaps and ambiguities, and fix issues inline with approval.

The output is a review artifact (`docs/reviews/<topic>-tests.md`) and a review stamp on the plan's Tests section. What the user approves becomes the behavioral contract the implementation must satisfy.

## Process

### 0. Gather Context

1. **Read the brainstorm** — `docs/brainstorms/<topic>.md`. This is the intent source. Key decisions and the chosen direction define what the tests should cover. If no brainstorm exists, the architecture alone defines intent — note this and proceed.

2. **Read the plan** — `docs/plans/<topic>.md`, focusing on the Architecture section (especially Interfaces) and the Tests section (interface files, test files, behaviors covered). If the Tests section doesn't exist, tell the user and stop — suggest running the test-writing skill first.

3. **Read the actual test files** listed in the plan's Tests section. Read the interface files too — these are what the tests exercise.

### 1. Validate

Check the tests against these criteria:

- **Brainstorm intent coverage.** Every key decision and behavioral expectation from the brainstorm should have corresponding test coverage. Map brainstorm intent to test behaviors — identify gaps where intent has no test and tests that cover something the brainstorm didn't ask for.

- **Abstraction level.** Tests should be at component boundaries — public surface in, observable result out. Flag any test that reaches into internals, tests private functions, or depends on implementation details that don't exist yet.

- **Interface-only testing.** Tests should exercise the materialized interfaces from the architecture. Flag any test that imports or references code that isn't an interface definition — it's testing something that doesn't exist yet or shouldn't be tested at this level.

- **Path coverage.** Each component boundary should have happy paths, boundary conditions, and error cases. Flag components with only happy-path tests or missing error handling coverage.

- **No non-deterministic tests.** Flag any test that depends on timing, randomness, network state, filesystem ordering, or other non-deterministic factors.

- **Reasonable expectations.** Test assertions should be satisfiable by any correct implementation of the interface. Flag over-specified expectations that constrain implementation unnecessarily — asserting on internal state, demanding specific error message strings beyond what the interface defines, requiring specific call counts or ordering not in the contract.

### 2. Escalate and Fix

Walk through findings with the user. This is interactive — one issue or group of related issues at a time.

**Escalate to the user:**

- Brainstorm intent that no test covers — trace the gap back to its source. If the architecture doesn't cover the intent either, that's an architecture gap, not just a test gap. If the architecture covers it but the test writer missed it, that's a test-writing gap. Either way, the user decides whether it needs coverage or is intentionally untested.
- Tests that cover something the brainstorm didn't describe — the user decides whether to keep or remove
- Tests at too low an abstraction level — explain why and propose a higher-level replacement
- Ambiguous expectations — where the test asserts something the interface doesn't clearly define

**Fix inline with approval.** When the user agrees an issue needs fixing, make the change directly — edit the test file, update the interface if needed, adjust the plan's Tests section to match. Don't batch fixes for later; fix as you go.

**Architecture gaps are fixable here.** When missing test coverage traces back to brainstorm intent the architecture didn't include, don't punt back to the architect phase. With the user's approval, update the architecture section of the plan (add the missing interfaces/decisions), then add the corresponding tests and interface code. This review has the brainstorm, the architecture, and the tests all in context — it's the right place to catch and close these gaps.

**Use judgment on severity.** Not everything needs escalation. Minor naming issues, slightly redundant tests, or trivially fixable gaps can be noted and fixed with a brief mention. Save escalation for genuine ambiguity or missing coverage that could affect implementation.

### 3. Write the Review

Create `docs/reviews/<topic>-tests.md` following the artifact format below. If the file already exists (a prior review), number it: `<topic>-tests-2.md`, `<topic>-tests-3.md`, etc.

### 4. Stamp and Commit

Add the review stamp to the plan's Tests section — append `**Review status:** approved` at the end of the `## Tests` section in `docs/plans/<topic>.md`.

Commit all changes (any test/interface fixes, review artifact, plan stamp) with message: `test-review: <topic>`

## Artifact Format

```markdown
# Test Review: [Topic]

**Plan:** `docs/plans/<topic>.md`
**Brainstorm:** `docs/brainstorms/<topic>.md`
**Date:** [date]

## Summary

[2-3 sentences. Overall assessment — do the tests cover the brainstorm intent? Are they at the right abstraction level? Are there gaps? Give the reader the headline.]

## Findings

### 1. [Short title]

- **Category:** missing coverage | wrong abstraction | over-specified | non-deterministic | unplanned scope
- **Severity:** critical | warning | nit
- **Location:** `path/to/test.ts:42-58`
- **Status:** resolved | dismissed

[What was found and what was done about it. Reference the brainstorm intent or architecture interface involved. Note whether the user approved the resolution.]

### 2. [Short title]

[...]

...

## No Issues

[If validation turned up nothing, say so explicitly. "All brainstorm intent is covered. Tests are at component boundaries. No non-deterministic tests found." This confirms the review was thorough, not skipped.]
```

### Format Rules

- **Summary first** — the reader should know the overall verdict before diving into findings.
- **Findings are numbered sequentially.** Order by severity (critical first), then by category.
- **Every finding has all five fields** — category, severity, location, status, description. No exceptions.
- **Status is `resolved` or `dismissed`** — this is an interactive review, so every finding should be addressed before the review is written. `resolved` means the issue was fixed. `dismissed` means the user decided it's not a problem — include their reasoning.
- **Severity meanings:**
  - `critical` — missing coverage for key brainstorm intent, tests at entirely wrong abstraction level, or non-deterministic tests that will cause false failures
  - `warning` — incomplete path coverage, slightly over-specified expectations, or tests for unplanned scope that may or may not belong
  - `nit` — minor naming issues, slightly redundant tests, trivial improvements. Use sparingly.
- **Category meanings:**
  - `missing coverage` — brainstorm intent with no corresponding test
  - `wrong abstraction` — test reaches into internals or depends on implementation details
  - `over-specified` — assertions that constrain implementation beyond what the interface defines
  - `non-deterministic` — test depends on timing, randomness, or external state
  - `unplanned scope` — test covers behavior not described in brainstorm or architecture
- **Location is specific** — file path and line range.
- **If there are no findings**, the review file still gets written with an empty findings section and a note confirming the review was clean.

## Key Principles

- **The brainstorm is the intent** — tests should cover what the brainstorm decided to build. Missing coverage is a gap. Extra coverage is a question for the user.
- **Interactive, not one-shot** — walk through findings with the user. Escalate ambiguity. Fix with approval. The review is a conversation, not a report dropped on the user's desk.
- **Fix as you go** — when the user approves a fix, make it immediately. Don't accumulate a fix list for later.
- **Every finding is resolved** — by the time the review artifact is written, every finding should be either fixed or explicitly dismissed by the user. No open items.
- **The stamp is the gate** — the review stamp on the Tests section signals that the behavioral contract is approved and ready for implementation planning. Don't stamp until the user is satisfied.
