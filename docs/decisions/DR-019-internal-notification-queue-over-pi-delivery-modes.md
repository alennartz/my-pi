# DR-019: Internal notification queue over pi delivery modes

## Status
Accepted

## Context
The subagents extension needs to deliver inter-agent notifications (agent_complete, group_idle, agent_message) to the parent LLM. Pi provides two built-in delivery modes: `steer` (delivered after current tool calls, before next LLM call) and `followUp` (delivered after agent finishes entirely). Both were tried and rejected. With `steer`, each notification arrived as a separate message, creating a cascading preemption loop — the agent would react to one notification, get interrupted by the next steer, react again, and so on. When the agent tried to ask the user a question, the next steer would hijack the turn before the user could answer. `followUp` had a similar one-at-a-time draining problem, just delayed to turn boundaries.

## Decision
Accumulate notifications in an internal queue and flush as a single combined message. When the parent is idle, flush immediately and set `parentBusy = true` synchronously — before `sendMessage` returns — so any notification arriving between the flush and the async `agent_start` event sees the correct state. When the parent is busy, notifications accumulate and flush on `agent_end`. The flushed message uses `triggerTurn: true` with default steer delivery, but since it only fires when idle, it always starts a fresh turn.

## Consequences
The parent sees one batched message per idle→busy transition instead of N separate interrupts. The state machine is fully event-driven with no timers. Trade-off: notifications arriving microseconds apart when idle won't batch (the first triggers an immediate flush), but this is harmless — subsequent ones queue and arrive as a steer before the next LLM call.
