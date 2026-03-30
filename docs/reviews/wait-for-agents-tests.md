# Test Review: wait-for-agents

**Plan:** `docs/plans/wait-for-agents.md`
**Brainstorm:** `docs/brainstorms/wait-for-agents.md`
**Date:** 2026-03-30

## Summary

Tests cover all key brainstorm intent — wait resolution on agent completion or parent-bound messages, any-message interrupt semantics, concatenated XML return format, and cancellation. They're at the right abstraction level (NotificationQueue component boundary), import only from the interface file, and have no non-deterministic behavior. Two coverage gaps were found and fixed; one nit was dismissed.

## Findings

### 1. Missing test for `clearPendingTools()`

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/notification-queue.test.ts` (steer delivery section)
- **Status:** resolved

The interface defines `clearPendingTools()` — "clear all tracked tool calls without triggering a flush" — but no test exercised it. An implementation could accidentally trigger a flush on clear, or leave stale tool tracking state. Added a test that tracks a tool call, queues a notification, calls `clearPendingTools()`, and verifies no flush occurred and the queue is intact.

### 2. Missing test for notification preservation after cancellation

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/notification-queue.test.ts` (wait cancellation section)
- **Status:** resolved

Cancellation tests verified the promise rejects, isWaiting clears, and normal delivery resumes — but didn't verify that queued notifications survive cancellation. An implementation could silently clear the queue on abort. Added a test that queues a notification, starts a wait, aborts, and verifies `queue.length` is still 1.

### 3. Uplink notifications flushable after drainLocal

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `extensions/subagents/notification-queue.test.ts:255-262`
- **Status:** dismissed

The drainLocal test verifies uplink entries are retained by count (`queue.length === 1`) but doesn't verify they can be delivered via flush. The count check is sufficient — if the entry is in the queue, flush will find it. User chose to skip.

### 4. Duplicated Tests section in plan

- **Category:** unplanned scope
- **Severity:** nit
- **Location:** `docs/plans/wait-for-agents.md`
- **Status:** resolved

The plan had two complete `## Tests` sections with overlapping but slightly different behavior lists — artifact from the test-write phase. Removed the second (less detailed) section and updated the first to reflect the actual test file including newly added tests.
