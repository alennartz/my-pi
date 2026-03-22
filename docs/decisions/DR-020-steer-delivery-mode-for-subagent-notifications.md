# DR-020: Steer-delivery mode for subagent notifications

## Status
Accepted

## Context
DR-019 chose an internal notification queue with idle-only flushing to prevent cascading steer interrupts. This works but creates a serial bottleneck for coordinated multi-agent workloads — each batch of notifications forces a full LLM round-trip before the next batch can be seen. In orchestrated implementation (implementing skill), workers complete in parallel but the parent processes completions one-turn-at-a-time.

## Decision
Add a `USE_STEER_DELIVERY` flag that relaxes the idle-only flush constraint. When enabled, the same internal queue is used (preserving batching and drain-on-teardown), but the `parentBusy` guard is bypassed: notifications flush immediately via `sendMessage({ triggerTurn: true })`, and an additional `tool_execution_end` trigger flushes mid-turn. Pi routes these through its steering queue when the agent is streaming, delivering them between tool-call rounds. `agent_end` remains as fallback for notifications arriving while the LLM is mid-response (no tool calls to trigger a flush).

## Consequences
Parent can absorb worker completions mid-turn instead of waiting for idle, reducing coordination latency. The original cascading-interrupt concern from DR-019 is mitigated by the queue's batching — multiple notifications arriving during one tool call flush as a single combined message, not N separate steers. Trade-off: `agent_end` fallback still has followUp-like latency for notifications arriving during LLM streaming.
