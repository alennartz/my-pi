# Test Review: Autonomous Workflow

**Plan:** `docs/plans/autonomous-workflow.md`
**Brainstorm:** `docs/brainstorms/autonomous-workflow.md`
**Date:** 2026-04-04

## Summary

The tests comprehensively cover the only programmatic interface in the architecture — `checkTransitionArtifact()`. All seven autonomous phases have happy-path, missing-file, and missing-section tests where applicable, with especially thorough coverage for the `implement` phase (multiple non-done status variants). One gap was found: the cleanup check only verified plan file removal while the architecture specified broader working-artifact cleanup including review files. This was resolved by adding review file checks with user approval.

## Findings

### 1. Cleanup check too narrow — missing review file validation

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/workflow/autoflow-checks.test.ts:312-340`
- **Status:** resolved

The architecture's artifact check table specified cleanup should verify "working artifacts cleaned" and the interface doc comment mentioned "plan, reviews." However, the tests only checked that the plan file was absent. Added two new test cases: one verifying failure when `docs/reviews/<topic>.md` still exists, another for `docs/reviews/<topic>-tests.md`. Updated the interface doc comment, plan behaviors section, and architecture table to be precise about what cleanup checks. User approved the expansion.
