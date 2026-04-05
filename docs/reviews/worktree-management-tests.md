# Test Review: Worktree Management

**Plan:** `docs/plans/worktree-management.md`
**Brainstorm:** `docs/brainstorms/worktree-management.md`
**Date:** 2026-04-05

## Summary

The test suite now covers the brainstorm’s core worktree flows and the architecture’s session-replacement design at the right abstraction level. During review I found two coverage gaps: controller tests were missing resume/cancellation branches, and the extension entrypoint wiring was untested. Both were fixed inline and the plan’s Tests section was updated to match.

## Findings

### 1. Missing resume fallback and cancelled-create coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/worktree/controller.test.ts:76-157`
- **Status:** resolved

The architecture requires two controller branches that were previously untested: resuming an existing worktree should fall back to a fresh session when no persisted session exists yet, and create-time user interactions may be cancelled (`docs/plans/worktree-management.md:25-39`, `64-76`). The original tests only covered the happy-path resume and create flows, even though the runtime/session contracts exposed these alternate paths. With approval, I updated `extensions/worktree/contracts.ts` so `continueRecent()` can return `undefined`, added controller tests for resume fallback, cancelled context-transfer / pending-changes prompts, and a cancelled `switchSession()` return, and refreshed the plan’s Tests section to describe those behaviors.

### 2. Untested extension entrypoint wiring

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/worktree/index.ts:1-31`
- **Status:** resolved

The brainstorm’s direction is explicitly a `/worktree` extension with command handling and branch autocomplete, but there was no test covering the top-level extension boundary. The existing tests only exercised pure helpers and the controller, so an implementation could mis-register the command or mis-wire handler/autocomplete behavior without a failing test. With approval, I added `extensions/worktree/index.test.ts` covering command registration, create/cleanup dispatch, parse-failure notification, and autocomplete wiring, and updated the plan’s Tests section accordingly.

## No Issues

After those fixes, the reviewed tests cover the intended create/resume/cleanup behaviors, stay at component boundaries, and remain interface-focused. I did not find non-deterministic assertions or implementation-detail coupling in the remaining test surface.
