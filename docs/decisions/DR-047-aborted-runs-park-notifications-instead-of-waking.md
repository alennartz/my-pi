# DR-047: An aborted run parks its queued notifications instead of waking on them

## Status
Accepted

## Context
`interrupt` hung and the interrupted child kept working. Both symptoms came from one mechanism. `AgentSet.interrupt` calls `session.abort()`, which is `agent.abort()` followed by `waitForIdle()`. On the child side, the subagents extension's `agent_settled` handler called `queue.setParentBusy(false)`, whose busy→idle edge flushes queued notifications with `triggerTurn: true`. Pi runs extension `agent_settled` handlers *inside* `_emitAgentSettled`, before the `finally` that resolves idle waiters — so the flush started a fresh run, `_resolveIdleWaitIfIdle` saw `_isAgentRunActive` true again and declined to resolve, and the parent's `await` sat there while the child worked on. Any child with its own subagents re-armed the cycle on every settle.

The same flush also fired from `tool_execution_end` while the aborted run unwound, steering notifications into a run that was about to discard its queues.

A log scan over three months found six instances in child sessions: an assistant turn with `stopReason: "aborted"`, then a new turn seconds later with no user message, in one case calling `respond` against correlation IDs that had gone stale in the interim. The root TUI Escape path has the same shape — it clears the SDK queues and aborts, but cannot see the extension's own notification queue — though no instance appeared in the logs, since Escape at root is usually followed by the operator typing.

The forcing question was what happens to notifications that arrive while an agent is being stopped. Delivering them defeats the interrupt; dropping them loses a subagent's only completion report.

## Decision
An aborted run settles without triggering the next one, and its queued notifications are parked rather than dropped: `agent_end` records `stopReason === "aborted"`, `agent_settled` consumes the flag to settle the queue with `{ flush: false }`, and `deferAll()` hands the accumulated notifications to `pi.sendMessage(…, { deliverAs: "nextTurn" })`. Pi holds them in `_pendingNextTurnMessages` and prepends them to whatever prompts the session next — a parent `send`, a resume, or the user typing at root. `tool_execution_end` skips the round-boundary flush when `ctx.signal?.aborted`, so the unwinding path cannot deliver either.

The rule lives in the session that owns the queue, not at the interrupt site, so root Escape gets the same behaviour with no caller involvement.

`SubagentManager.interrupt` additionally stopped awaiting idle unconditionally: it returns `"settled" | "pending"` on a bounded wait (10 s, also cancellable by the caller's own signal). The notification fix removes the known restart path, but a tool that ignores its abort signal — a nested `interrupt`, for one — can still keep a run alive, and an unbounded wait converts that into a hang with no way out.

Rejected alternatives:

- **Drop the queued notifications on abort**, mirroring what the TUI does to the SDK steering queue. Simplest, and it makes the interrupt maximally quiet. Rejected because a `<agent_idle>` report is a grandchild's only delivery of its result; losing it strands work that was actually completed, and since custom messages are never persisted to the session log, the loss leaves no trace to debug from.
- **Keep the flush, make `interrupt` fire-and-forget.** Fixes the hang and matches the "equivalent to Escape" comment on `AgentSet.interrupt`. Rejected because it fixes only the symptom the parent sees: the child still restarts immediately, so an interrupt that returns "Interrupted" is a lie, and root Escape still bounces straight back into a turn.
- **Have the parent clear the child's queue at the interrupt site.** Requires a new control path from the manager into the child's extension instance, puts abort policy in the caller rather than in the session that owns the queue, and does nothing for root Escape, which has no such caller.
- **Suppress the flush and simply leave entries queued.** No new delivery mode needed. Rejected because nothing guarantees a later flush: held notifications would sit invisible until some unrelated notification happened to arrive, and a user prompt would not carry them at all.

## Consequences
Delivery now depends on pi's `deliverAs: "nextTurn"` semantics (`_pendingNextTurnMessages`, consumed at the next prompt). If upstream narrows when that queue drains, parked notifications go quiet rather than loud — the failure mode is silence, which is harder to notice than a spurious turn.

An interrupted agent that is never prompted again never sees its parked notifications. That is intended — an interrupted agent's news waits until someone talks to it — but teardown discards them, so "interrupt, then tear down" silently drops whatever arrived during the stop.

Abort detection reads `stopReason` off the last assistant message at `agent_end`, the same string coupling `terminalError` already carries. A provider or SDK that reports aborts differently would silently restore the old behaviour; the integration test asserting `deliverAs: "nextTurn"` is the only guard.

`tool_execution_end` now branches on `ctx.signal?.aborted`. If pi ever clears the run signal before unwinding completes, that guard stops firing and the steer-path flush returns.

`interrupt` has two success outcomes, and callers must distinguish them: `"pending"` means the abort was delivered but the child had not settled within the window. The 10 s constant is a guess, not a measurement.

Bucket-one loss remains unfixed: notifications already steered into the SDK queue are discarded by the TUI's `clearAllQueues()` on Escape, and the extension cannot see or recover them. Fixing it needs an upstream change or a delivery path that does not route through `agent.steer`.

Notification delivery is invisible in session logs — no `role: "custom"` entry is ever persisted — so a turn triggered by a notification looks like an assistant message materializing from nothing. Any future debugging of delivery timing has to work from behaviour, not from the log.
