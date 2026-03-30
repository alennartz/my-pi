# Review: wait-for-agents

**Plan:** `docs/plans/wait-for-agents.md`
**Diff range:** `0c206c413bd5101b670694a56cae490bd6865c6a..78f8026eda405b02de9b629d600fe37c0ee2c412`
**Date:** 2026-03-30

## Summary

The plan was implemented faithfully across all three steps — notification queue extraction, inline replacement in index.ts, and the new `await_agents` tool registration. No meaningful plan deviations. One critical finding: `await_agents` resolves on the first event instead of waiting for all scoped agents to complete, making the `agents` parameter effectively broken. Two additional warnings and two nits.

## Findings

### 1. `await_agents` resolves on first event instead of waiting for all scoped agents

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/subagents/notification-queue.ts:71-76` (`queue()` method), `extensions/subagents/index.ts:856-862`
- **Status:** open

When `await_agents` is called with an `agents` array (or omitted to mean "all"), the expectation is that it blocks until all specified agents are idle or failed. The current implementation does not do this — `queue.wait()` resolves on the *first* `queue()` call during the wait, regardless of how many agents remain active. The `agents` parameter only controls the `isAlreadySatisfied` early-exit check at wait start; once the wait is active, a single notification from any source resolves it immediately. This means `await_agents()` effectively means "wait for the next event" rather than "wait for these agents to finish." The resolution logic in `queue()` should check the satisfaction condition after each event and only resolve when all scoped agents are done, accumulating notifications until then.

### 2. `clear()` does not settle a pending wait promise

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/notification-queue.ts:97-98`, `extensions/subagents/index.ts:893`
- **Status:** open

`clear()` empties the entries array but does not resolve or reject an active `wait()` promise. During `session_shutdown` (index.ts:892-893), `queue.clear()` is called while `await_agents` could be in-flight. If the tool's `AbortSignal` fires independently (which it likely does — pi cancels tool calls on shutdown), the abort handler properly rejects and cleanup is fine. But if the ordering is unlucky — `clear()` runs before abort fires, then the await in `execute` never unblocks — the tool execution hangs. `clear()` should reject any active wait before clearing entries. The `waitReject` field (finding 2) appears to exist for exactly this purpose but is never called.

### 3. `waitReject` stored but never invoked

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/notification-queue.ts:65,143,193`
- **Status:** open

`this.waitReject` is assigned in `wait()` (line 143) and nullified in `cleanupWait()` (line 193), but is never read or called anywhere. The abort handler captures the Promise constructor's `reject` via closure rather than using `this.waitReject`. This is dead state that looks like it exists for programmatic rejection (e.g., from `clear()`) but isn't wired up. Fixing finding 1 would make this field useful.

### 5. Empty `agents` array causes immediate vacuous return

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/index.ts:847-862`
- **Status:** open

If `params.agents` is `[]` (empty array, which passes the `Type.Array` schema), validation succeeds (the for-loop body never runs), `scopedIds` is `[]`, and `isAlreadySatisfied` calls `scopedIds.every(...)` on an empty array — which returns `true` (vacuous truth). `wait()` immediately resolves and the tool returns "All specified agents have already completed." This is a degenerate input unlikely from a model, but it silently succeeds rather than erroring.

## No Issues

Plan adherence: no significant deviations found. All three steps were implemented faithfully per the architecture. Test files were not modified during implementation. The `process.cwd()` → `ctx.cwd` changes in workflow and subagent files were a separate drive-by fix committed before the pre-implementation baseline and are not part of this implementation's scope.
