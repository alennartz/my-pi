# Review: In-process subagents

**Plan:** `docs/plans/in-process-subagents.md`
**Diff range:** `00505c2969ce8ab4713fb222ec45a65b5cdd6c1b..HEAD`
**Date:** 2026-07-16

## Summary

The implementation covers the planned in-process architecture and the full Vitest suite passes (38 files, 445 tests), but several runtime lifecycle and routing defects remain. In particular, idle message delivery, registry snapshot replacement, and recursive correlation routing can strand work or corrupt canonical state; the implementation also violates the plan's test immutability rule.

## Findings

### 1. Idle messages do not trigger a turn

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/subagents/scoped-extension.ts:112-116`
- **Status:** open

`pi.sendMessage()` is called without `{ triggerTurn: true }`. When a session is idle, the SDK appends the custom message but does not run the agent, so completion notifications and messages sent to idle children are never processed. Blocking sends can remain pending indefinitely and parent completion can stall.

### 2. Session replacement restores a stale operational snapshot

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/subagents/agent-session-registry.ts:148-170,215-222`
- **Status:** open

The decorated `onSessionChanged` hook closes over the construction-time `currentSnapshot`, while `updateOperational()` replaces the live node snapshot. A later resume, fork, or new-session replacement spreads that stale value back into the node, discarding accumulated usage, output, errors, and state (and potentially reverting an idle node to running). This also violates the function-level closure rule against capturing a reassignable lifecycle value.

### 3. Recursive correlation IDs can route responses through the wrong port

- **Category:** code correctness
- **Severity:** critical
- **Location:** `extensions/subagents/message-router.ts:85,349-355`; `extensions/subagents/scoped-extension.ts:109,272-275,320-324,824-829`
- **Status:** open

Each parent-local router starts its correlation sequence at `corr-1`, while a recursive scope records blocking-message origins in one map keyed only by that string for both its uplink and local child router. Concurrent requests on those ports can collide, overwrite the origin, and send `respond` through the wrong router, breaking blocking waits and response ownership.

### 4. Implementation changed an immutable replacement test

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `extensions/subagents/managed-child-session.integration.test.ts:53-72`
- **Status:** open

The plan requires test files to remain immutable during implementation and explicitly says the replacement tests remain unchanged. This diff adds an assistant-message fixture to the integration test (in addition to the planned deletion of `broker.test.ts`). Even if the fixture makes a test pass, changing a reviewed test invalidates the test/implementation boundary and must be resolved or explicitly re-planned.

### 5. Registry teardown races with creation and overlapping removal

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.ts:127-140,225-264`
- **Status:** open

Removal leaves nodes visible while awaiting disposal, snapshots descendants before that await, and has no effective removing/disposed guard (`InternalNode.disposing` is unused). A concurrent child creation can commit beneath a node already being removed and become orphaned; overlapping removals can dispose or emit the same session twice; creation after `dispose()` can leak because subsequent disposal reuses the old promise. The plan requires idempotent, subtree-safe lifecycle ownership.

### 6. Registry batch creation is observable before the batch is committed

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.ts:199-204`
- **Status:** open

The implementation inserts and emits each `node_added` event one at a time after releasing reservations. A subscriber can observe a partial batch and create a duplicate for a later path after its reservation has already been released. The plan requires committing all immutable nodes before emitting any add event so creation is atomic to observers.

### 7. Staged operational updates are dropped during construction

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.ts:215-223`
- **Status:** open

`updateOperational()` only looks in the committed-node map. Events can arrive after session construction starts but before the batch commits; those updates are discarded instead of being retained on staged nodes and published with the committed snapshot, contrary to the Step 5 contract.

### 8. Manager membership mutations are not serialized

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/agent-set.ts:182-263,295-304,888-930`
- **Status:** open

`start`, teardown, and shutdown mutate entries, router endpoints, and topology across awaits without a per-manager operation lock. Parallel tool calls can let a failed spawn roll back a successful sibling's endpoint or let teardown detach a child that was concurrently committed. Registry reservations do not protect these manager-local mutations.

### 9. The external root snapshot never receives operational updates

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.ts:102-103,215-217`; `extensions/subagents/scoped-extension.ts:191-201`
- **Status:** open

The external root is stored separately from `nodes`, but `updateOperational([])` only searches `nodes`. Root lifecycle projection therefore becomes a no-op and `getSnapshot([])` remains at its construction-time state, so root status, usage, output, and completion projections are stale.

### 10. Recursive owner waiting state is not projected

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/subagents/agent-set.ts:743-768`
- **Status:** open

Waiting/correlation callbacks only locate an immediate child entry. When a manager's own parent endpoint is the sender (`from === "parent"`), root sends and recursive child-manager sends return without updating the owner node/root `pendingCorrelations`, `waitingFor`, or state. This omits the planned blocking-start/end projection for recursive owners.

### 11. Root projection omits context-window metadata

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/subagents/scoped-extension.ts:335-365`
- **Status:** open

`projectRootMessage()` updates root usage, model, output, and turn input but never writes `contextWindow`, despite Step 7 requiring the external root's assistant usage/model/context/output transitions to flow through the registry snapshot.

### 12. Trust-hook errors are treated as child prompt failures

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/managed-child-session.ts:348-355`; `extensions/subagents/agent-set.ts:684-726,237-247`
- **Status:** open

Project-trust handler failures are correctly non-decisive in the trust resolver, but they are reported through an error-level UI notification. During construction the manager interprets that notification as a pre-start prompt failure, marks the pending child failed, and disconnects its router endpoint, while still submitting the initial task. A recoverable trust-hook error can therefore create a child that is reported failed and unreachable.

### 13. Resource-loader diagnostics are silently discarded

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/managed-child-session.ts:340-375`
- **Status:** open

The managed session does not inspect or surface resource-loader extension/skill diagnostics. A broken cwd extension or explicit skill can disappear while the child is presented as successfully running, making isolated resource failures invisible and difficult to diagnose.

### 14. Shutdown requests do not stop the managed runtime

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/managed-child-session.ts:207-225`; `extensions/subagents/agent-set.ts:481-486,729-731`
- **Status:** open

The shutdown callback only marks the node failed and disconnects routing; it never aborts or disposes the managed session. The SDK runtime can continue executing and retain resources behind a node reported as unavailable, and a later registry removal may race with that still-running work.

### 15. Legacy fork-tool compatibility is only preserved by an unsafe cast

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/subagents/agents.ts:30-38`; `extensions/subagents/agent-set.ts:958-963`
- **Status:** open

`ForkAgentSpec.tools` remains required even though Step 6 requires an absent legacy `tools` field to remain `undefined` and select the default policy. The implementation relies on `as any` at the restore boundary, so the public structural contract does not represent the compatibility case and future callers can accidentally reintroduce the explicit-empty fork policy.

## Verification

- Plan-adherence and code-correctness passes completed.
- `npx vitest run` passed: 38 files, 445 tests.
- The named pre-rebase WIP stash remains preserved for audit/recovery.
