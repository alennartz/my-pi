# Test Review: In-process subagents

**Plan:** `docs/plans/in-process-subagents.md`
**Brainstorm:** `docs/brainstorms/in-process-subagents.md`
**Date:** 2026-07-16

## Summary

This narrow reopening validates the architecture correction that keeps lifecycle policy in each parent manager while passing path-bound `ChildSessionHooks` through the registry. The corrected tests cover hook decoration, metadata-before-callback ordering, independent hooks in a batch, and a live recursive registry fixture that exercises the registry boundary rather than a direct managed-session shortcut. The previously approved router, trust, persistence, path, tool-policy, UI, and managed-session suites remain unchanged.

The focused Vitest invocation parsed both changed suites. Their 23 failures remain the expected test-write state because `AgentSessionRegistry` and `createSubagentsExtension` are still interface stubs; no runner or fixture error was introduced.

## Findings

### 1. Batch creation did not prove that hook decoration stayed request-local

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.test.ts:249-315`
- **Status:** resolved

The first reopened test covered one manager-supplied hook set only. A batch could therefore cross-wire replacement callbacks while still satisfying that test. The suite now captures decorated hooks by canonical path for two requests, fires both replacements, and verifies that each manager callback and snapshot receives only its own metadata.

### 2. The recursive registry fixture bypassed live-parent ownership and did not prove registry use

- **Category:** wrong abstraction
- **Severity:** critical
- **Location:** `extensions/subagents/scoped-extension.integration.test.ts:71-244,414-473`
- **Status:** resolved

The prior fixture accepted a grandchild below an absent parent and the integration test only observed `createManagedChildSession`, so a direct child-construction implementation could have passed without honoring the registry contract. The fixture now seeds the scoped parent path, validates live parent and sibling identity, decorates replacement hooks, and maintains observable snapshots. The recursive test asserts the `createChildren(ownerPath, requests)` boundary, manager-supplied hooks, canonical child snapshot/listing, and replacement metadata projection.

## No Issues

- `CreateAgentNodeRequest.hooks` is a public, path-bound interface field. The registry test exercises it only through `createChildren()` and observable snapshots/events; lifecycle and status decisions remain manager-owned.
- The manager callback sees replacement metadata only after the registry snapshot changes, while event, UI-notification, and shutdown callbacks are forwarded unchanged.
- The recursive fixture is deterministic: it has no timing, network, randomness, or filesystem-order dependency. It models only enough live registry state to exercise child-manager recursion; the registry's full atomic/removal contract remains covered by its dedicated suite.
- The reopened test-write SHA in the plan now correctly identifies `00505c2969ce8ab4713fb222ec45a65b5cdd6c1b`. The prior approved suite files were not altered by this narrow review.
- No tests were added for out-of-scope recursive reporting, historical state, registry persistence, or Pimote integration.
