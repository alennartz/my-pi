# pi SDK: no reliable signal for "the agent has really gone idle"

## Problem

External consumers of an `AgentSession` (including any out-of-process
consumer over the RPC pipe) have no clean way to answer the question
"has this agent finished working?"

`agent_end` is the closest candidate, but it's overloaded: it fires on
every attempt-ending, including attempts that pi itself is about to
continue. Today there are at least two code paths where an `agent_end`
is emitted with pi already holding information that says "not really —
I'm about to keep going":

1. **Auto-retry on a retryable error** (overloaded / rate-limit / 5xx /
   connection errors).
2. **Auto-compaction on context overflow** (`_checkCompaction` →
   `_runAutoCompaction("overflow", willRetry: true)`).

In both cases, the wire order is the same:

```
agent_end            ← consumer thinks "done"
{retry or compact lifecycle}
agent_start          ← pi silently continues
...
agent_end            ← the real one
```

And in both cases, pi knows synchronously at the time it emits the
premature `agent_end` that more work is coming — the retry path sets
`_retryPromise` in `_createRetryPromiseForAgentEnd` before
`_processAgentEvent` even runs, and the overflow path detects overflow
on the last assistant message whose `stopReason` / error payload is
already in hand. The information is there; it just isn't on the event.

Consumers are left with three ugly choices:

- Duplicate pi's retryable-error and context-overflow heuristics on
  their side (brittle, leaky).
- Defer every `agent_end` by a tick and cancel if
  `auto_retry_start` / `compaction_start` arrives (latency penalty on
  every real completion, and the debounce-cancel race has to be
  reasoned about).
- Accept false positives and live with the bug (what the subagents
  extension did by accident — it wasn't looking for either).

## Real-world hit

An autoflow run spawned an `implement` subagent for voice-mode. The
session was interrupted and resumed (cleanly — pi's session-resume
behavior is not at fault). Shortly after resume, the child's LLM call
errored with `overloaded_error`. The child emitted `agent_end`
2ms before the parent's `await_agents` returned "idle (no output)."
Three seconds later, auto-retry fired and the child ran for another 20
minutes doing real implementation work — but the parent had moved on
under the false assumption that the subagent was done.

Sessions involved (for reference):
- Parent: `...pimote.../2026-04-21T00-08-36-616Z_019dad5e-....jsonl`
  around 00:55:27Z.
- Child: `...subagents/sessions/2026-04-21T00-49-12-997Z_019dad83-....jsonl`
  — `stopReason: "error"` at 00:55:27.590Z, `session-idle` at
  00:55:27.591Z, next assistant message at 00:55:31.267Z (auto-retry).

This is an auto-retry case. The auto-compaction/overflow case hasn't
bitten us yet, but it has the same shape and the same outcome would
follow from it.

## pi already has the information, synchronously

### Auto-retry path

`_createRetryPromiseForAgentEnd` runs synchronously in
`_handleAgentEvent` before the agent_end is queued for processing:

```js
_handleAgentEvent = (event) => {
    this._createRetryPromiseForAgentEnd(event);  // sets this._retryPromise iff will retry
    this._agentEventQueue = this._agentEventQueue.then(
        () => this._processAgentEvent(event), ...);
};
```

By the time `_emit(agent_end)` runs inside `_processAgentEvent`, pi
already knows whether a retry is pending — `this._retryPromise` is set.
It just doesn't put that fact on the event, and the eventual
`auto_retry_start` emit happens strictly *after* `_emit(agent_end)`
returns.

(Caveat: `_retryPromise` being set means "pi intends to attempt a
retry," not "pi is guaranteed to actually retry." If `_retryAttempt`
exceeds `maxRetries` inside `_handleRetryableError`, pi emits
`auto_retry_end { success: false }` and stops without retrying. That
case needs to resolve cleanly under whatever fix ships — see below.)

### Auto-compaction overflow path

`_isContextOverflow` is evaluated against the last assistant message's
`stopReason` / error payload inside `_checkCompaction`, which is
called from `_processAgentEvent` *after* `_emit(agent_end)` has already
fired. The check itself is synchronous on data already in memory at
emit time — it could happen before the emit.

## Proposed change

Whatever shape the fix takes, the invariant we want is:

> A consumer can write a single terminal-signal rule — **when this
> event arrives, the agent is really done working** — without
> duplicating pi's internal retry or compaction heuristics and without
> race-sensitive deferral.

Below are three shapes, from least to most invasive.

### Option A (minimal): emit the "continuation is pending" event *before* the errored `agent_end`

Reorder the emits so that `auto_retry_start` (and an equivalent
"overflow recovery starting" signal) precedes the per-attempt
`agent_end` it belongs to. Both emits already exist for the retry
path; pi just emits them after `_emit(agent_end)` today. For the
overflow path, `compaction_start` is already the right signal — it
just needs to move ahead of the triggering `agent_end` (or a new
`compaction_will_start` event emitted synchronously before).

New wire sequence, auto-retry:

```
message_end(assistant, error)
auto_retry_start(attempt=N)
agent_end                     ← consumer sees retry_start first, flags "retrying"
{sleep}
agent_start
...
agent_end                     ← terminal (retrying=false, success)
```

New wire sequence, overflow:

```
message_end(assistant, overflow error)
compaction_start(reason="overflow")
agent_end                     ← consumer sees compaction_start first, flags "compacting"
compaction_end(willRetry=true)
agent_start
...
agent_end                     ← terminal
```

Consumer rule collapses to:

```ts
// toggles
on auto_retry_start    -> retrying = true
on auto_retry_end      -> retrying = false
on compaction_start    -> compacting = true      // (or only when reason==="overflow")
on compaction_end      -> compacting = false

// terminal detection
on agent_end when !retrying && !compacting -> agent is really done
```

Maximum retries exhaustion: pre-emit is skipped on the attempt that
would exceed `maxRetries`, and `auto_retry_end { success: false }` is
emitted as today. The trailing `agent_end` is correctly interpreted
as terminal (retrying was briefly true, flipped false by
`auto_retry_end`, then `agent_end` arrives with retrying=false).

Since `_emit` is synchronous and writes to the RPC pipe in order, the
pre-emits and the `agent_end` arrive in-order at any consumer — no
race across the process boundary.

Smallest diff, no new event types, no new fields. Recommended.

### Option B: `willRetry` / `willContinue` on `agent_end`

Add a boolean field to `AgentEndEvent`:

```ts
interface AgentEndEvent {
    type: "agent_end";
    messages: AgentMessage[];
    willContinue: boolean;   // true if auto-retry or overflow-recovery will resume this turn
}
```

Set from `!!this._retryPromise || willOverflowRecover` at emit time.
Precedent: `compaction_end.willRetry` already carries a similar flag.

Consumers: ignore `agent_end` with `willContinue: true`, wait for the
next `agent_end { willContinue: false }`.

Caveat: on max-retries exhaustion, `_handleRetryableError` emits
`auto_retry_end { success: false }` and stops without a subsequent
`agent_end`. Either re-emit a final `agent_end { willContinue: false }`
after exhaustion (recommended — one consistent consumer contract), or
document that consumers must also treat `auto_retry_end { success:
false }` as terminal.

More consumer-friendly than Option A (each event is self-describing,
no state machine), but adds API surface.

### Option C: new `agent_settled` event

Keep `agent_end` as the per-attempt signal (which is what it naturally
is today). Add a new event that fires exactly once per "agent is
really done working":

```ts
interface AgentSettledEvent {
    type: "agent_settled";
    outcome: "success" | "failed" | "aborted";
    finalMessages: AgentMessage[];
    retriesAttempted: number;
    compactionsAttempted: number;
    finalError?: string;
}
```

- Emitted after a clean `agent_end` (no retry, no compact-and-continue)
  → `success`.
- Emitted after retry exhaustion → `failed`, with `retriesAttempted`.
- Emitted after overflow-recovery failure → `failed`.
- Emitted after user abort → `aborted`.
- Not emitted for any per-attempt `agent_end` that leads to a
  continuation.

Consumers who want "is the agent done?" semantics subscribe to
`agent_settled`. Consumers who want per-attempt granularity (progress
UIs, telemetry) stay on `agent_end`.

Most invasive, but reads best at the API surface — two events with two
distinct meanings rather than one overloaded event disambiguated by a
flag or a state machine. This is the shape we'd pick if we were
designing the API from scratch.

## Recommendation

**Option A** is the smallest change that fixes the ambiguity for all
current continuation cases (auto-retry + overflow-compaction) without
adding API surface. It also generalizes cleanly to any future "pi
continues the turn internally" feature: emit the "continuation is
starting" event first, then the per-attempt `agent_end`.

**Option C** is what we'd recommend if the SDK is open to adding an
event — the `agent_settled` semantic is what consumers actually want,
and it preserves `agent_end` as the per-attempt signal that power
users of the event stream want anyway.

Option B is a reasonable middle ground but keeps `agent_end`
overloaded, just with a disambiguator.

## Downstream cleanup (our repo)

Once pi ships this, `extensions/subagents/agent-set.ts:handleRpcEvent`
can just:

```ts
// Option A
if (event.type === "auto_retry_start") entry.retrying = true;
if (event.type === "auto_retry_end")   entry.retrying = false;
if (event.type === "compaction_start" && event.reason === "overflow") entry.compacting = true;
if (event.type === "compaction_end"   && event.reason === "overflow") entry.compacting = false;
if (event.type === "agent_end" && !entry.retrying && !entry.compacting) {
    entry.status.state = "idle";
    ...
}

// Option C
if (event.type === "agent_settled") {
    entry.status.state = event.outcome === "failed" ? "failed" : "idle";
    ...
}
```

No regex duplication, no microtask deferral, no racing with
continuation events.
