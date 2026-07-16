# Review: In-process subagents (fix verification)

**Plan:** `docs/plans/in-process-subagents.md`
**Diff range:** `18b28da..HEAD`
**Date:** 2026-07-16

## Summary

The fix commit resolves all fifteen findings from the prior review, including the intentionally corrected legacy-session fixture. The targeted subagent regression set passes (9 files, 93 tests). Two residual edge cases remain in the fix diff: committed snapshots are retained in the staging map, and caller-supplied duplicate correlation IDs remain ambiguous across recursive ports.

## Prior Findings Verification

| Prior finding | Verification |
| --- | --- |
| Idle notifications did not trigger a turn | **Resolved.** Notification delivery now passes `triggerTurn: true`. |
| Session replacement restored stale operational state | **Resolved.** Replacement hooks read the current live/staged snapshot. |
| Generated recursive correlation IDs collided | **Resolved for generated IDs.** Routers now use per-router UUID namespaces. See Finding 2 for explicit-ID residual ambiguity. |
| Legacy-session fixture violated the test boundary | **Resolved by the intentional fixture correction.** The assistant entry materializes the ordinary JSONL file that a resumable RPC-era session must contain; no production workaround was added. |
| Registry teardown raced with creation/removal | **Resolved.** Removal markers, reservation waits, idempotent node disposal, and a disposed guard prevent subtree races. |
| Registry batch visibility was not atomic | **Resolved.** All nodes are committed before reservations are released or `node_added` events are emitted. |
| Staged operational updates were dropped | **Resolved.** Staged snapshots retain pre-commit updates. |
| Manager membership mutations were not serialized | **Resolved.** Start, restore, teardown, and soft shutdown share a mutation tail. |
| External root snapshot did not update | **Resolved.** Root snapshots now have an explicit update path. |
| Recursive owner waiting state was not projected | **Resolved.** Parent-endpoint correlations update the owning root/child node. |
| Root projection omitted context-window metadata | **Resolved.** Root message projection derives and stores the model context window. |
| Trust-hook errors falsely failed children | **Resolved.** Setup diagnostics use the non-fatal diagnostic hook. |
| Resource-loader diagnostics were discarded | **Resolved.** Service and extension diagnostics are surfaced through child diagnostics. |
| Shutdown requests left runtimes running | **Resolved.** Shutdown bindings cooperatively abort the session before marking it unavailable. |
| Legacy fork tools required an unsafe cast | **Resolved.** `tools` and `skillPaths` are optional in `ForkAgentSpec` and preserved as `undefined`. |

## Findings

### 1. Committed snapshots leak through the staging map

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/agent-session-registry.ts:290-294,392-403`
- **Status:** open

`updateOperational()` stores every committed node's replacement snapshot in `stagedSnapshots`, even though the live node is already held in `nodes`. Removal never deletes that staging entry. Repeated activity followed by teardown therefore retains full snapshots—including potentially large `lastOutput` strings—for every removed node, causing unbounded per-root memory growth. Only genuinely staged nodes should use this map, or removal must clear the committed-path entry.

### 2. Explicit duplicate correlation IDs can still cross-wire recursive responses

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/scoped-extension.ts:281-285,847-866`
- **Status:** open

Generated IDs are now namespaced and safe, but the public `MessagePort` interface still accepts caller-supplied IDs. If the same explicit ID is pending simultaneously on the local child router and the recursive uplink, `correlationOrigin` keeps both ports and tries them in insertion order. The first port can accept the response as a valid target, so the response may resolve the wrong pending request; a failed-port retry cannot disambiguate two valid matches. Origin-qualified keys or a scope-level rejection of duplicate explicit IDs are needed.

## Verification

- Targeted verification: `npx vitest run extensions/subagents/agent-session-registry.test.ts extensions/subagents/agent-set.test.ts extensions/subagents/managed-child-session.test.ts extensions/subagents/managed-child-session.integration.test.ts extensions/subagents/message-router.test.ts extensions/subagents/scoped-extension.test.ts extensions/subagents/scoped-extension.integration.test.ts extensions/subagents/persistence.test.ts extensions/subagents/session-snapshot.test.ts`
- Result: 9 files passed, 93 tests passed.
- The named pre-rebase WIP stash remains preserved for audit/recovery.
