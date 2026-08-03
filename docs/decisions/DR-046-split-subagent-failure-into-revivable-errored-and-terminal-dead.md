# DR-046: Split subagent failure into revivable `errored` and terminal `dead`

## Status
Accepted

## Context
A child whose run ended in an error was settled as `failed`, which routed through `MessageRouter.agentUnavailable` — a permanent tombstone in `unavailableAgents` plus an endpoint disconnect. `assertCanDeliver` then re-threw the stored error string verbatim on every subsequent `send`, so an agent whose source condition had since been cleared stayed unreachable for the lifetime of the group, even though its session was alive and promptable. Only teardown + resurrect (which calls `router.connect`, the sole tombstone-clearing path) could recover it.

`failed` was terminal in three independent places, so no single patch was sufficient: the router tombstone, the disconnected endpoint whose listeners were cleared, and an `agent_start` guard in `agent-set.ts` that refused to leave the state. The great majority of failures reaching this path — provider errors surfaced via `pendingTerminalError`, error-level notifies from a blocked prompt (DR-041) — leave the child runtime fully intact; only `onShutdownRequested` means the runtime is actually gone. One state was carrying two very different meanings, and it resolved them both as death.

## Decision
Two settled-with-error states, replacing `failed`:

- **`errored`** — the run failed, the session is alive. Pending waits resolve with the real error via a new `MessageRouter.agentErrored`, which records no tombstone and leaves the endpoint connected and subscribed. `agent_start` clears both the state and `lastError`, so a later `send` genuinely revives the agent.
- **`dead`** — the runtime is gone. Tombstone and disconnect as before; teardown + resurrect is required.

Producers split accordingly: provider errors, rejected child input, and rejected initial-task submits settle as `errored`; only `onShutdownRequested` produces `dead`. The model-facing vocabulary follows the states — `<agent_idle status="errored">` carries the error plus a retry hint, `status="dead"` keeps the resurrect hint.

Rejected alternatives:

- **Clear the tombstone when sending to a failed agent.** Symptom-level. It leaves `failed` sticky in `agent-set.ts`, and clearing the tombstone alone cannot restore delivery: the endpoint's listeners were already cleared, and reconnecting mints a new endpoint object that the child — holding a `MessagePort` closed over the dead one — is not subscribed to.
- **Keep `failed` as the recoverable state and add `dead` alongside it.** The smallest diff, and it would have left the model's notification vocabulary untouched. Rejected because a name that reads terminal while meaning recoverable is precisely what let this bug hide for so long; the router author and the `agent-set` author could both read `failed` and be locally correct.
- **No new state — let `lastError` distinguish clean from errored idle.** Keeps the enum at two settled states, but turns "did the last run fail?" into an implicit convention that every consumer re-derives, and erases the at-a-glance distinction in the widget.

## Consequences
The enum has five members, so every exhaustive `Record<AgentState, …>` map — widget icons, border and activity colors, footer counts, panel card colors and labels — is one more place to keep in sync when states change.

The vocabulary the model sees changed: `status="failed"` became `status="errored"` or `status="dead"`, and an errored agent is now told to retry by sending rather than to resurrect. Prompt text, skills, or operator habits that reference a "failed" subagent are stale.

`dead` has exactly one producer, so the terminal path is now rarely exercised and a regression in it would be easy to miss; it is covered only by the root-orchestration integration test.

An agent can now cycle `errored → running → errored`, emitting an `<agent_idle>` notification per settle. This was already true of clean idles, so it is not new behaviour, only newly reachable after a failure.

`markAgentWaiting` guards only `dead`, so an out-of-order blocking-send-start arriving after a settle could project an errored agent back to `waiting`. Accepted because `onBlockingSendStart` fires synchronously inside a running child's `send` tool call, which cannot outlive that child's settle.

`interrupt` remains a no-op for both `errored` and `dead`, preserving the behaviour a failed child had before this change, even though an errored agent's live session could technically be aborted.
