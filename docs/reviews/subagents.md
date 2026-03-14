# Review: Subagents

**Plan:** `docs/plans/subagents.md`
**Diff range:** `5102910..6778a9d`
**Date:** 2026-03-14

## Summary

The plan was faithfully implemented — all 11 steps are complete and the architecture is intact. Two correctness issues stand out: the broker's blocking-send protocol doesn't match what the BrokerClient expects (missing acknowledgment causes a hung `waitForNext`), and the BrokerClient's FIFO waiter dispatch can consume unrelated messages, desynchronizing the protocol. There's also a dead code path where the "waiting" agent state is never set because the relevant calls live in a branch that's unreachable for normal child agents.

## Findings

### 1. Missing send_ack for blocking sends causes hung tool calls

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/subagents/broker.ts:226-228`, `extensions/subagents/index.ts:318-337`
- **Status:** resolved

The broker only sends `send_ack` for fire-and-forget sends (`if (!expectResponse)`). For blocking sends, no acknowledgment is sent — the next message the sender receives will be the `response` (when the target eventually calls `respond`).

But the client code in `index.ts` expects two messages for a blocking send: first an ack from `sendAndWait()`, then the actual response from `waitForNext()`. When the `response` arrives as the first message, `sendAndWait` consumes it. Then `waitForNext()` hangs indefinitely waiting for a second message that will never arrive.

The fix is either: (a) have the broker send `send_ack` for blocking sends too (before the response arrives), or (b) restructure the client to use a single `waitForNext` for blocking sends instead of the two-step pattern.

### 2. BrokerClient waiter queue doesn't discriminate by message type

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/index.ts:89-96`
- **Status:** resolved

`BrokerClient.waitForNext()` pushes a callback onto a FIFO waiter queue. When any message arrives on the socket, the first waiter gets it regardless of type. If the broker forwards an unrelated `message` (from another agent) between the client sending a request and receiving the expected `send_ack` or `response`, the waiter consumes the wrong message. The actual ack/response then gets dispatched to the `messageHandler` instead.

This could cause: (a) a fire-and-forget send's `sendAndWait` to receive an agent message instead of `send_ack`, throwing or returning unexpected results; (b) an incoming agent message to be silently dropped (consumed by a waiter that ignores it). The risk scales with group activity — more concurrent inter-agent messages increase the chance of interleaving.

A correlation-based dispatch (matching responses by a request ID or by expected type) would be more robust than positional FIFO.

### 3. Agent "waiting" state is never set for non-recursive children

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/index.ts:354-356`, `extensions/subagents/group.ts:329-346`
- **Status:** open

`setAgentWaiting` and `clearAgentWaiting` are only called in the child's send-tool path, guarded by `childIdentity && activeGroup`. For a normal child agent (not one that spawned its own sub-group), `activeGroup` is always null — it's only set in the root process when a group is spawned. The root's send-tool path (parent sending to agents) doesn't call these methods either.

Result: the `⏸ waiting` state in the widget never displays. `AgentStatus.state` never transitions to `"waiting"`, and `pendingCorrelations` is always empty. The `waiting` state in the architecture (running→waiting on blocking send, waiting→running on response) is defined but unreachable.

### 4. Unused import in group.ts

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/group.ts:5`
- **Status:** resolved

`buildTopology` is imported from `./channels.js` but never used — the topology is passed in via `GroupManagerOptions`. Dead import.

## No Issues

Plan adherence: no significant deviations found. All 11 steps were implemented as specified. Minor adaptations (widget function taking `fg` instead of full `Theme`, `collectEvents()` omitted from RpcChild since unused, `teardown_group` using `followUp` instead of `steer` for the completion report) are reasonable implementation-time choices that don't change behavior or intent.
