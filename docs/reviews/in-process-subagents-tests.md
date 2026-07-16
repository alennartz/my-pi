# Test Review: In-process subagents

**Plan:** `docs/plans/in-process-subagents.md`
**Brainstorm:** `docs/brainstorms/in-process-subagents.md`
**Date:** 2026-07-16

## Summary

The suite now exercises the current per-root-registry design at public component boundaries: canonical paths, atomic registry lifecycle, stable delegating UI, scoped extension construction, and the single normalized SDK tool policy. It retains router, trust, persistence, legacy-session, and SDK lifecycle coverage while closing gaps in failed-interrupt parity, per-root isolation, fork inheritance, model/service propagation, and deterministic fixtures. No intent ambiguity remained to escalate.

A focused Vitest run parsed all 110 reviewed tests. Thirty-four preserved domain tests passed; the remaining 76 are intentionally red against the test-write interface stubs and the still-RPC-backed manager, which implementation will replace.

## Findings

### 1. Failed-node interruption parity was not explicit in the manager contract

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `docs/plans/in-process-subagents.md:428-436`; `extensions/subagents/agent-set.test.ts:157-195`
- **Status:** resolved

The approved parity rule requires `interrupt` to leave a failed registry node alone rather than attempting cooperative cancellation. The manager contract and method documentation now say so, and the boundary test proves that it resolves without calling the managed session's `abort()` method while unknown paths still report an error.

### 2. Registry-construction concurrency assumed a microtask turn

- **Category:** non-deterministic
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.test.ts:174-191`
- **Status:** resolved

The overlapping-creation test used `await Promise.resolve()` to guess when session construction had begun. It now waits for an explicit construction signal before issuing the competing request, so it verifies path reservation without coupling to an implementation's await schedule.

### 3. Registry rollback and immutable snapshots had incomplete boundary assertions

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.test.ts:145-164,193-233,303-318`
- **Status:** resolved

The tests now prove that a failed atomic batch releases its reservation for a retry, that nested operational input cannot leak into a stored snapshot, and that repeated registry disposal does not dispose a descendant twice. These are the observable consequences of atomic creation, immutable snapshots, and idempotent ownership cleanup.

### 4. Root-scoped registry ownership was only implied

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `extensions/subagents/scoped-extension.integration.test.ts:396-417`
- **Status:** resolved

The architecture requires one live registry per root rather than a process-global tree. The integration test now starts two root factories with the same local child ID and verifies that their child scopes carry different registries while retaining root-relative paths.

### 5. Fork orchestration did not protect full active-tool inheritance

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `extensions/subagents/scoped-extension.integration.test.ts:419-454`
- **Status:** resolved

The brainstorm preserves forks, and the architecture requires them to inherit the parent's complete active tool set, including extension tools, through the one normalized policy. The new public-tool test verifies SDK fork targeting, parent thinking and skills, preservation of an extension tool, removal of `ask_user`, addition of `respond`, and initial task submission.

### 6. Managed-session construction could resolve a model without applying it, or share child services

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/managed-child-session.test.ts:368-447`
- **Status:** resolved

The component assertions now require the CLI-resolved model to reach SDK session construction. A sibling-session case also requires isolated EventBus and settings instances while retaining the root's shared auth storage and model registry.

### 7. Trust continuation covered only synchronous handler failures

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/project-trust.test.ts:146-164`
- **Status:** resolved

`project_trust` handlers may be asynchronous. The test now rejects asynchronously, verifies error reporting, and requires the next handler's decisive result to win over the configured default.

### 8. The persisted-session snapshot fixture used randomness for its filename

- **Category:** non-deterministic
- **Severity:** nit
- **Location:** `extensions/subagents/session-snapshot.test.ts:8-28`
- **Status:** resolved

The fixture now uses a per-test sequence number inside its isolated temporary directory. It retains unique filenames without making test execution depend on random output.

### 9. The orchestration fake omitted the managed session's presentation seam

- **Category:** wrong abstraction
- **Severity:** warning
- **Location:** `extensions/subagents/scoped-extension.integration.test.ts:21-33`
- **Status:** resolved

A registry-owned managed session exposes a stable `DelegatingExtensionUI`; the integration fake did not. It now supplies that public shape, so the orchestration test remains compatible with registry presentation attachment instead of accidentally modeling an incomplete child interface.

## No Issues

- Canonical-path tests cover root identity, immutable segment append, ordered escaped names, and delimiter-safe display/session names.
- Registry tests cover external-root ownership, sibling and nested paths, atomic construction, immutable state publication, session replacement, bottom-up removal, path reuse, attachment tokens, subscriber isolation, and host-owned root disposal.
- Delegating-UI tests cover the complete current `ExtensionUIContext` surface, stable binding, headless forwarding, attachment, stale-detach protection, and reset without a second bind.
- Child tool-policy and scoped-factory tests enforce the current single-policy design: both scopes register the same definitions, while the normalized SDK policy alone supplies persona/fork restrictions, always includes `respond`, and always excludes `ask_user`.
- The parent-local message-router suite remains at its public port boundary and preserves authorization, immediate correlation registration, deadlock rejection, typed lifecycle failures, detach/cancel behavior, reconnection, shutdown, and blocking-status projection.
- Public-SDK trust precedence, version-1 persistence/log compatibility, cwd/tool/skill restoration, and deterministic JSONL snapshot recomputation remain covered. The real-SDK legacy-session test retains direct reopening without changing the persisted session ID or cwd.
- No reviewed test relies on timing, network state, random values, or filesystem ordering.
