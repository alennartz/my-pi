# Review: Subagents

**Plan:** `docs/plans/subagents.md`
**Diff range:** `5102910..86caf54`
**Date:** 2026-03-14

## Summary

The plan was faithfully implemented across all 11 steps, and the prior review's critical/warning findings have been resolved. One critical correctness issue remains: the BrokerClient dispatches blocking-send responses by FIFO position rather than by correlation ID, so concurrent blocking sends (the scatter-gather pattern explicitly promoted in promptGuidelines) will cross-deliver responses to the wrong callers. One nit for inconsistent XML escaping.

## Findings

### 1. Concurrent blocking sends cross-deliver responses via FIFO dispatch

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/subagents/index.ts:419-431`, `extensions/subagents/index.ts:457-469`
- **Status:** resolved

When a parent or child agent makes two concurrent blocking sends (e.g., `send(to=A, expectResponse=true)` and `send(to=B, expectResponse=true)` in the same LLM turn), both call `sendAndWait()` then `waitForNext()` on the same `BrokerClient`. The waiter queue is pure FIFO — when a `response` arrives, the first waiter gets it regardless of which `correlationId` it carries.

Trace for concurrent sends to A and B where B responds first:

1. Call A: `sendAndWait` → waiter1. Call B: `sendAndWait` → waiter2.
2. Both receive `send_ack` in order → waiter1 and waiter2 resolve.
3. Call A: `waitForNext` → waiter3. Call B: `waitForNext` → waiter4.
4. B's response arrives → dispatched to waiter3 (Call A's waiter). Call A returns B's response. ✗
5. A's response arrives → dispatched to waiter4 (Call B's waiter). Call B returns A's response. ✗

The `BrokerResponse` type already includes `correlationId` on response messages — the information needed to match correctly is present but unused. The fix is to match `response` (and `error` with `correlationId`) messages to their caller by correlation ID rather than by queue position, similar to how `RpcChild` matches responses by request `id`.

This is critical because scatter-gather is explicitly promoted in the `send` tool's `promptGuidelines` ("For scatter-gather: call send(expectResponse=true) to multiple agents in the same turn") and in the architecture's Interfaces section. Any LLM following those guidelines will hit this bug.

### 2. Unescaped output in `serializeAgentComplete`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/messages.ts:79`
- **Status:** resolved

`serializeAgentForXml` does not XML-escape the agent's `output` for idle agents:

```typescript
const output = agent.output ?? "(no output)";
return `<agent_complete ...>\n${output}\n</agent_complete>`;
```

Meanwhile, `serializeGroupIdle` (line 90) and `serializeGroupComplete` (line 111) both call `escapeXml(out)` on the same data. If an agent's last assistant message contains `</agent_complete>` or similar XML-like content, the `<agent_complete>` block steered to the parent could confuse the LLM about where the block ends. Low risk since these are LLM-consumed, not machine-parsed, but the inconsistency suggests the escaping was intended and missed here.

## No Issues

Plan adherence: no significant deviations found. All 11 steps were implemented as specified. The prior review's four findings (missing `send_ack` for blocking sends, FIFO waiter consuming wrong message types, unreachable waiting state, unused import) are all resolved — the broker now sends `send_ack` for both send types, the BrokerClient routes `message`-type responses directly to the message handler bypassing waiters, waiting state is driven by broker callbacks (`onBlockingSendStart`/`onBlockingSendEnd`), and the unused import is removed.
