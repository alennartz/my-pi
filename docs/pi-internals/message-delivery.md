# Pi Internals: Message Delivery Modes

## Source

- `agent-session.js` in `@mariozechner/pi-coding-agent` (v0.61.1)
- Key methods: `sendCustomMessage()`, `sendUserMessage()`, `prompt()`, `steer()`, `followUp()`

## Overview

Pi has three delivery modes that control when a message reaches the agent. These apply to both `sendMessage()` (extension API) and `sendUserMessage()`, though `nextTurn` is only available on `sendMessage`.

The modes interact with two internal queues and a stash:
- **Steering queue** (`_steeringMessages`) — messages injected between tool-call rounds
- **Follow-up queue** (`_followUpMessages`) — messages delivered after the agent is fully idle
- **Next-turn stash** (`_pendingNextTurnMessages`) — messages silently bundled into the next prompt

## Delivery Modes

### `steer`

**When streaming:** Queued via `agent.steer()`. Delivered after the current assistant turn finishes executing its tool calls, but *before* the next LLM call within the same agentic loop. Interrupts between steps — the agent sees the message mid-work.

**When idle:** Falls through to the default path — acts like a regular `prompt()` call (for `sendCustomMessage` with `triggerTurn: true`) or `appendMessage` (without `triggerTurn`).

**Default behavior:** If no `deliverAs` is specified and the agent is streaming, `steer` is the default for `sendCustomMessage`.

### `followUp`

**When streaming:** Queued via `agent.followUp()`. Waits until the agent has no more pending tool calls *and* no more steering messages. Only fires when the agent is truly done with everything in its current turn, then triggers a new turn.

**When idle:** Same fallthrough as steer — `prompt()` or `appendMessage`.

**Key difference from steer:** Steer interrupts between tool-call rounds; followUp waits until the entire multi-step agentic loop completes.

### `nextTurn`

**Only available on `sendMessage`, not `sendUserMessage`.**

Does not go through the steer/followUp queues at all. The message is pushed into `_pendingNextTurnMessages`. These messages:

1. **Do not trigger a turn on their own** — they silently accumulate
2. **Are injected as context alongside the next `prompt()` call** — when something else triggers the next turn (user input, a followUp delivery, etc.), all pending nextTurn messages are bundled into the messages array alongside the user message
3. **Are then cleared** from the stash

This makes nextTurn a "passive piggyback" mode — the message waits for somebody else to initiate a turn, then rides along as additional context.

## Queue Drain Modes (Settings)

Two settings control how queued steer/followUp messages are drained:

- **`steeringMode`**: `"one-at-a-time"` (default) or `"all"`
- **`followUpMode`**: `"one-at-a-time"` (default) or `"all"`

With `"one-at-a-time"`, pi delivers one queued message, waits for the agent to respond, then delivers the next. With `"all"`, all queued messages are delivered at once.

## Behavior Matrix

| Condition | `steer` | `followUp` | `nextTurn` |
|-----------|---------|------------|------------|
| Agent streaming | Queue, deliver between tool rounds | Queue, deliver when fully idle | Stash silently |
| Agent idle + `triggerTurn` | `prompt()` immediately | `prompt()` immediately | Stash silently |
| Agent idle, no trigger | `appendMessage()` | `appendMessage()` | Stash silently |
| Triggers a turn? | Yes (when delivered) | Yes (when delivered) | Never on its own |

## Note: `triggerTurn` + Streaming

When `sendCustomMessage` is called with `triggerTurn: true` while the agent is already streaming, the message is routed through the steer/followUp branch based on `deliverAs`, not through the `prompt()` path. The `triggerTurn` flag is **redundant** in this case, not ignored — the agent loop's `runLoop()` (agent-loop.js) drains both steering and follow-up queues and triggers a new `streamAssistantResponse()` for each drained message. The turn happens regardless; it's just deferred until the appropriate drain point (between tool-call rounds for steer, after the loop completes for followUp).

## Relevant Code Locations

- `sendCustomMessage()` — dispatch logic for all three modes (~line 894 in agent-session.js)
- `prompt()` — drains `_pendingNextTurnMessages` into the messages array (~line 712)
- `_queueSteer()` / `_queueFollowUp()` — internal queue push + agent queue call (~lines 840-863)
- `steer()` / `followUp()` — public API with skill/template expansion (~lines 812-829)
