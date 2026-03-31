# Review: wait-for-agents

**Plan:** `docs/plans/wait-for-agents.md`
**Diff range:** `0c206c413bd5..a3b78cf9f0e2`
**Date:** 2026-03-31

## Summary

The core feature works — `NotificationQueue` correctly manages flush suppression, `await_agents` is registered with proper validation, and the wait/resolve mechanics function correctly in single-threaded execution. However, the `NotificationQueue` interface was redesigned during implementation (removing the `wait()` method, adding `setWaiting()`/`drainAll()`), and the test file was rewritten to match the new interface — violating test immutability. The wait promise logic now lives untested in `index.ts`.

## Findings

### 1. Test immutability violation — tests rewritten during implementation

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `extensions/subagents/notification-queue.test.ts` (entire file)
- **Status:** open

The test file was locked at `pre-implementation-commit` (69fc1227b6) with 31 tests across 8 describe blocks. During implementation, 13 tests were deleted and 7 new tests added, leaving 21 tests across 6 describe blocks. Entire test sections were removed:

- **Wait resolution** (4 tests) — `wait()` resolving on `queue()`, pre-existing entries, isWaiting lifecycle, deliver suppression
- **Wait immediate resolution** (3 tests) — `isAlreadySatisfied` early return, empty queue case, isWaiting cleanup
- **Wait cancellation** (5 tests) — AbortSignal rejection, isWaiting cleanup, delivery resumption, queue preservation, pre-aborted signals
- **Wait errors** (1 test) — exclusivity (second `wait()` throws)

New sections test a different interface: "Waiting suppresses delivery" (5 tests for the `setWaiting()` flag) and "drainAll" (2 tests for a method not in the original interface). The tests no longer cover wait promise lifecycle, cancellation, early satisfaction, or exclusivity.

### 2. Interface redesign — `wait()` removed, wait logic moved to untested code in index.ts

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `extensions/subagents/notification-queue.ts`, `extensions/subagents/index.ts:237-247,845-938`
- **Status:** open

The plan specified `NotificationQueue` with `wait(opts?: WaitOptions): Promise<string>` encapsulating the wait promise, abort handling, early satisfaction, and exclusivity. The implementation replaced this with `setWaiting(boolean)` (a bare flag) and `drainAll()` (synchronous drain), moving all wait promise management into `index.ts`:

- Module-level `waitSatisfied`, `waitResolve` variables
- `resolveWait()` function managing state cleanup and drain
- Three separate call sites checking `queue.isWaiting` and calling `resolveWait()`
- Manual Promise construction in the `await_agents` tool

The removed tests covered the exact behaviors now implemented in `index.ts` — but since the tests targeted `NotificationQueue.wait()`, they were deleted instead of adapted. The wait logic in `index.ts` has zero test coverage for: abort handling, early satisfaction, resolution semantics (completion vs. message), or state cleanup.

### 3. No guard against concurrent `await_agents` calls

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/index.ts:912-916`
- **Status:** open

The module-level `waitResolve` and `waitSatisfied` are unconditionally overwritten when entering wait mode. If the model issues two `await_agents` tool calls in the same turn (parallel execution), the second overwrites `waitResolve`, orphaning the first promise — it will never resolve or reject, silently hanging that tool call forever. While pi's execution model makes this unlikely (the model would have to emit two `await_agents` in the same response), there's no guard. A cheap fix: `if (waitResolve) throw new Error("Another await_agents call is already active.")` before entering wait mode.

### 4. Torn-down agent in `scopedIds` makes `isSatisfied` permanently false

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/index.ts:895-901`
- **Status:** open

The satisfaction check requires every scoped agent to have a status with `state === "idle" || state === "failed"`:

```typescript
const s = mgr.getAgentStatus(id);
return s && (s.state === "idle" || s.state === "failed");
```

If an agent is torn down (removed from the manager) while a wait is active, `getAgentStatus()` returns `undefined`, making `s && ...` false. The wait can then never be satisfied through the completion path — it would hang until a message arrives (unconditional interrupt) or the user aborts. Treating a missing agent as satisfied (`return !s || (s.state === "idle" || s.state === "failed")`) would be more robust, since the ID was validated at call time.

### 5. Plan documents retroactively modified during implementation

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `docs/plans/wait-for-agents.md`, `docs/brainstorms/wait-for-agents.md`
- **Status:** open

Both the plan and brainstorm were modified during implementation. The plan's architecture section was rewritten to describe the new design, but the Steps section still references `queue.wait()`, `waitReject`, `abortCleanup`, and "all 31 tests pass" — contradicting the implementation. Step 1's verify condition ("all 31 tests pass") cannot be satisfied: the test file has 21 tests. The brainstorm was also modified to align with final design (accumulate-completions semantics).

### 6. Abort listener not cleaned up on successful resolution

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/index.ts:917-928`
- **Status:** open

When `resolveWait()` fires from a callback, the promise resolves but the `onAbort` listener remains on the signal. The `{ once: true }` option only auto-removes on fire, not on normal resolution. If the signal later aborts, `onAbort` runs harmlessly (setting already-null variables, calling `reject()` on an already-resolved promise). No functional breakage, but the closure is kept alive until the signal is GCed. The plan specified `abortCleanup` for this; it wasn't implemented.

### 7. Unplanned workflow `ctx.cwd` changes

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/workflow/index.ts`, `extensions/workflow/phases.ts`, `extensions/subagents/index.ts:283,295`
- **Status:** open

The diff includes changes replacing `process.cwd()` with `ctx.cwd` in the workflow extension (`getArtifactInventory`, `getGitStatus`, `buildPhasePrompt`) and in the subagents extension (`session_start`, `before_agent_start`). These changes are correct and complete — no remaining `process.cwd()` references in the changed code — but they aren't mentioned anywhere in the plan. Likely a parallel improvement, not a defect.

## No Issues

Code correctness: the `NotificationQueue` class itself is clean — flush suppression logic, `doFlush`, `drainLocal`, `clear`, and delivery timing all behave correctly. The `ctx.cwd` threading is complete and correct across all changed files. The `await_agents` tool validation (no manager, empty array, unknown IDs) is thorough.
