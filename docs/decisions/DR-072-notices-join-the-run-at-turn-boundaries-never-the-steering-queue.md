# DR-072: Notices Join the Run at Turn Boundaries, Never the Steering Queue

## Status
Accepted

## Context
Supersedes DR-047 (An aborted run parks its queued notifications instead of waking on them), deleted at commit `de1c449c428794c2b3e5e605cdd23c8443ab4e90`. Its decision stands: an aborted run never wakes on its notices, and none are dropped. The delivery mechanism changes.

While the parent streamed, my-pi steered `<agent_idle>` and `<agent_message>` notices into pi's steering queue and removed them from its own. Pi's `clearQueue()` drops custom messages, and Pimote calls it on Stop and when a user pulls a queued message back into the editor. A completion could vanish without a trace (audit M17). DR-047 already named this loss and left it open.

Steering also raced waits. A message steered while the model wrote `await_agents` reached the model only after the tool batch, so it never interrupted the wait, and a child blocked on the parent could deadlock with the parent's await (audit H14).

Pi offers two paths that do not use the steering queue. A custom message sent with `triggerTurn: false` while a run is active is appended at the next turn end, after the turn's tool results. `turn_end` and `agent_before_settle` handlers can return `continue: true` to ask for one more model request.

## Decision
Notices stay in my-pi until the parent can take them:
- Parent idle: one `subagents` message starts a turn. Notices that arrive in the same tick share it.
- Parent running: at each `turn_end` and `agent_before_settle`, queued notices go out with `triggerTurn: false` and the handler returns `continue: true`, so the next model request reads them in the same run.
- Parent waiting in `await_agents`: the wait consumes the completions it requested. Other notices wait for the next boundary.
- Aborted run: notices go out with `triggerTurn: false` and no turn. They sit in the transcript and the model reads them at the next prompt.

A `<agent_message>` that is queued when `await_agents` starts ends the wait at once, and the message follows the tool result.

Rejected: keep steering and have Pimote requeue non-user messages after `clearQueue()`. The fix would live in every host, and the TUI's Escape path would still drop them.

Rejected: boundary `entries` drafts. They persist without `message_start` and `message_end`, so live views would not see the row until a resync.

## Consequences
A notice reaches the model at the next turn boundary, after the current tool batch, as steering did. It can no longer arrive in the middle of a batch.

Delivery depends on pi's `_pendingCustomMessages` flush at `turn_end` and on boundary `continue`. If pi narrows either, notices arrive one run later instead of being lost.

A parked notice is now visible in the transcript at once, instead of appearing when the next prompt starts.
