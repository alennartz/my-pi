# Review: Subagents

**Plan:** `docs/plans/subagents.md`
**Diff range:** `5102910..c0d28d5`
**Date:** 2026-03-14

## Summary

The plan was implemented faithfully across all 11 steps. The multi-file extension architecture matches the plan's module decomposition, all five tools are registered with correct parameters and guidelines, and the broker/group/widget lifecycle operates as designed. One correctness issue found: stale deadlock graph edges when a sender agent dies, which can cause false positive deadlock detection in later sends.

## Findings

### 1. Stale deadlock graph edges when sender agent dies

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/broker.ts:101-107`
- **Status:** open

In `agentDied()`, the second cleanup loop removes pending correlations where the dead agent was the *sender*, but doesn't clean up the corresponding deadlock graph edges or `correlationTargets` entries:

```typescript
// Also clean up correlations where the dead agent was the sender
for (const [corrId, pending] of this.pendingCorrelations) {
    if (pending.from === agentId) {
        this.pendingCorrelations.delete(corrId);
    }
}
```

If agent A had a pending blocking send to agent B and agent A dies, the edge `A → B` remains in the deadlock graph and the `correlationTargets` entry leaks. The stale edge can cause false positive cycle detection: if a later `wouldCauseCycle(X, Y)` DFS traverses through the dead agent's outgoing edge, it may spuriously detect a cycle and reject a valid send.

Fix: look up each correlation's target via `correlationTargets`, call `removeEdge(agentId, target)`, and delete the `correlationTargets` entry — mirroring the cleanup pattern in the first loop.

### 2. BrokerClient has no post-connection socket error handling

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/index.ts:77-130`
- **Status:** open

After the initial connection/registration succeeds, the `BrokerClient` has no `close` or `error` event handler on the socket. If the unix socket drops unexpectedly after connection, any promises held by `waiters` or `correlationWaiters` hang forever — the `send` or `respond` tool call never resolves.

In practice this is mitigated by the managed lifecycle: the parent destroys children before stopping the broker, and child processes are killed during teardown. The risk is limited to unusual crash scenarios (e.g., broker socket file deleted externally). Noting it because the fix is straightforward (reject pending waiters on socket close) and would make the extension more robust against unexpected failures.

## No Issues

Plan adherence: no significant deviations found. All 11 steps are implemented as specified, including topology validation, deadlock detection, channel enforcement, agent discovery with skills, the TUI widget, and the full tool suite. Minor adaptations (broker callbacks for waiting state, `ThemeFg` function signature, `getBroker()` accessor) are reasonable implementation choices that serve the architecture's intent.
