# Plan: await_agents Tool

## Context

Add an `await_agents` tool that blocks until something interesting happens in the agent group — an agent completes, or an agent sends a message to the parent. This is a standalone primitive that decouples spawning from waiting; an `await` parameter on `subagent` can be layered on later as sugar. See [brainstorm](../brainstorms/wait-for-agents.md).

## Architecture

### Impacted Modules

**Subagents** — the only affected module. A new tool (`await_agents`) is registered alongside the existing six (subagent, fork, send, respond, check_status, teardown). The notification queue gains one additional guard condition, and the existing `onAgentComplete` / `onParentMessage` callbacks gain wait-resolution logic. Stop sequences are unaffected — the existing `<agent_complete` stop sequence is added on `subagent`/`fork` calls as before; `await_agents` doesn't need its own since the model is blocked on a tool call and can't hallucinate.

### Interfaces

#### Tool Schema

```
await_agents(agents?: string[])
```

- `agents`: optional array of agent IDs to wait on. Omit to wait on all agents in the group.
- Errors if no agents are running or if any specified ID is unknown.

#### Return Value

The tool result is a single text content block containing concatenated XML-tagged events (same `<agent_complete>` and `<agent_message>` format already used for notifications), joined by newlines. The model already parses this format.

#### Wait Resolution

Two things can resolve the wait:

1. **Agent completion** — an agent goes idle or failed. The `onAgentComplete` handler pushes to the notification queue via `queueNotification()`, then resolves the wait. The resolver drains the queue and returns its contents as the tool result.

2. **Parent-bound message** — any agent sends to parent (fire-and-forget or expect-response). The `onParentMessage` handler pushes to the queue, then resolves the wait the same way.

Both paths: push to queue first (so the triggering event is included in the drain), then resolve.

#### Flush Suppression

While a wait is active, `queueNotification` / `flushNotifications` suppress normal delivery (no `sendMessage`). This is a single guard condition: if the wait flag is set, accumulate only — don't flush. The flush logic does not know or care about the nature of the queued events; it just knows it's not time to flush.

#### Scoping

The `agents` parameter controls the natural completion condition: "all specified agents are idle/failed." Any event — including events from agents *not* in the scoped set — still triggers resolution. This preserves the interrupt semantics from the brainstorm: a message from any agent interrupts the wait regardless of scope, avoiding deadlocks and ensuring notifications are delivered promptly.

#### Cancellation

The tool receives an `AbortSignal` from pi. If the signal fires while the wait is blocking, the promise rejects, the wait flag is cleared, and normal notification delivery resumes. No special cleanup beyond restoring the flag.

#### Prompt Guidelines

Guidelines should convey:
- Use `await_agents` when you need results before your next step — it blocks until an agent completes or sends a message.
- Any agent message (including fire-and-forget) interrupts the wait. If an expect-response message interrupts, you must call `respond` before waiting again.
- After handling an interruption, call `await_agents` again to resume waiting.

## Tests

**Pre-test-write commit:** `0c206c413bd5101b670694a56cae490bd6865c6a`

### Interface Files

- `extensions/subagents/notification-queue.ts` — `NotificationQueue` class extracted from the inline notification queue closures in `index.ts`. Defines the queue + wait interface: `queue()`, `flush()`, `drainLocal()`, `clear()`, `setParentBusy()`, `trackToolStart/End()`, `clearPendingTools()`, `wait()`, plus `isWaiting` and `length` accessors. All methods throw "not implemented". Types: `NotificationQueueConfig`, `WaitOptions`, `NotificationSource`.
- `vitest.config.ts` — Vitest configuration targeting `extensions/**/*.test.ts`.

### Test Files

- `extensions/subagents/notification-queue.test.ts` — Behavioral tests for the `NotificationQueue` component covering normal delivery, steer delivery batching, queue management, wait resolution, flush suppression during waits, early satisfaction, cancellation, and exclusivity.

### Behaviors Covered

#### Normal Delivery (no wait)

- Flushes immediately when parent is idle (auto-flush on queue)
- Sets parentBusy=true synchronously before calling deliver (prevents double-flush race)
- Accumulates notifications when parentBusy and steerDelivery off
- Flushes accumulated notifications when parentBusy clears and flush() is called
- Concatenates multiple queued notifications with newline separators
- Does nothing when flushing an empty queue
- Explicit flush() is suppressed when parentBusy and steerDelivery off

#### Steer Delivery

- Flushes immediately when busy but no pending tool calls (LLM streaming)
- Accumulates while tool calls are pending
- Flushes when the last tracked tool call ends
- Does not flush on trackToolEnd when queue is empty
- clearPendingTools does not trigger a flush

#### Queue Management (drainLocal / clear)

- drainLocal removes local-source notifications and keeps uplink
- Preserved uplink notifications can be flushed after drainLocal
- clear removes all notifications regardless of source

#### Wait Resolution

- wait() returns a promise that resolves when queue() is called during the wait
- Pre-queued notifications are included in the wait result
- Queue is drained (emptied) on resolution
- Multiple events queued synchronously during wait are captured

#### Wait Flush Suppression

- Normal auto-delivery is suppressed while waiting (deliver callback not called)
- Explicit flush() is suppressed while waiting
- Normal delivery resumes after wait resolves
- Steer delivery flush (on trackToolEnd) is suppressed while waiting

#### Wait Early Satisfaction

- Resolves immediately when isAlreadySatisfied returns true, returning queued content
- Returns empty string when satisfied and queue is empty
- Blocks when isAlreadySatisfied returns false, resolves on next queue()

#### Wait Cancellation

- Rejects when AbortSignal fires during wait
- Clears isWaiting on cancellation
- Resumes normal delivery after cancellation
- Preserves queued notifications after cancellation (not lost)
- Rejects immediately if signal is already aborted at call time

#### Wait Exclusivity

- Rejects a second wait() call while one is already active

**Review status:** approved
