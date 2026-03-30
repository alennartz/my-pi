# Blocking Subagent Await

## Problem

After spawning a scout (or any short-lived search agent), the parent model duplicates the work itself. Stop sequences fixed the parent hallucinating `<agent_complete>` notifications, but the underlying drive remains — the model has the task in working memory and tools to execute it. Negative prompt instructions ("don't search yourself") have been tried and don't stick.

The root cause is architectural: there's an async gap between spawn and results where the parent has both motive and means to act.

## Idea

Add an `await` flag to the `subagent` tool. When set, the tool blocks until all spawned agents reach idle/failed, then returns their output directly as the tool result. No async gap, no opportunity to duplicate work.

Agents in an awaited group cannot send to parent (parent is blocked on the tool call and can't receive). Peer-to-peer channels still work.

## Design

**`group.ts`:**
- `start()` accepts `{ awaitMode?: boolean }` — skips adding "parent" to channels and parent to identity peers
- New `waitForSettled(agentIds: string[]): Promise<void>` — returns a promise that resolves when all specified agent IDs are idle/failed, driven by existing `onAgentComplete` / `monitorExit` paths (no polling)

**`index.ts`:**
- Add `await` optional boolean to subagent tool schema
- Track `awaitedAgentIds` set — `onAgentComplete` handler skips notification queueing for these
- When `await` is true: call `mgr.start()` with awaitMode, then `await mgr.waitForSettled(ids)` (raced against abort signal for cancellation), collect `lastOutput` from each agent's status, return as tool result
- Skip `stopSequences.addOnce` (no async gap to protect)
- Add prompt guideline: use `await: true` when you need results before your next step

Preserved: widget updates during the wait (onUpdate still fires), teardown still works normally after await completes (no auto-teardown), agents remain in the group for potential follow-up sends.
