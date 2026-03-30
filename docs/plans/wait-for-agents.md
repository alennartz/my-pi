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
