# Review: Dynamic Group Membership

**Plan:** `docs/plans/dynamic-group-membership.md`
**Diff range:** `3e1b8cce..f011b686`
**Date:** 2026-03-25

## Summary

All five plan steps were implemented faithfully — topology mutation functions, broker crash/removal split, group_idle removal, SubagentManager restructuring, and index.ts rewiring all match the plan's intent. One critical issue: `validateTopology` in the subagent tool still validates only within the new batch, rejecting the core incremental-add use case where new agents reference existing ones. A race condition in `teardownSingle` can produce spurious crash notifications.

## Findings

### 1. `validateTopology` rejects valid cross-batch channel references

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `extensions/subagents/index.ts:537-540`
- **Status:** resolved

The subagent tool calls `validateTopology(params.agents)` before `manager.start()`. This function builds its `allIds` set solely from the new batch. On incremental adds, if a new agent declares a channel to an already-running agent, `validateTopology` rejects it as "unknown peer" — even though `addToTopology` (called later in `group.ts:141`) would correctly accept it because it validates against both `existingIds` and `newIds`. This breaks the core use case of dynamic group membership: adding agents that communicate with previously-spawned agents. Either pass existing IDs into the validator, or remove the call entirely since `addToTopology` already validates.

**Resolution:** Removed the `validateTopology` call and its import from index.ts. `addToTopology` in channels.ts already validates channel references against both existing and new-batch IDs, making the pre-check redundant and incorrect for incremental adds.

### 2. Race between `monitorExit` and `teardownSingle` produces spurious crash notification

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/group.ts:331-344` and `437-458`
- **Status:** resolved

`teardownSingle` calls `await entry.rpc.stop()` (line 331), which kills the process and sets a non-zero exit code (SIGTERM). During the await, the `monitorExit` 500ms polling interval can fire. It passes the `!this.entries.includes(entry)` guard (entry hasn't been spliced yet), sees non-zero `exitCode`, and triggers the crash path: sets state to "failed", calls `broker.agentCrashed(id)` (sending synthetic error responses to blocked senders), and fires `onAgentComplete` (queuing a `<agent_complete status="failed">` notification). Then `teardownSingle` resumes and calls `broker.agentRemoved(id)` a second time. The result is a spurious "crashed" notification for an intentionally removed agent, which may confuse the orchestrating agent into error-handling behavior.

**Resolution:** Moved `this.entries.splice(entryIdx, 1)` before `await entry.rpc.stop()` in `teardownSingle`. The `monitorExit` polling loop already has a `!this.entries.includes(entry)` guard that bails out early — splicing first ensures the guard triggers before the SIGTERM exit code is observed.

### 3. Fork topology excludes same-batch peers in `addToTopology`

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/channels.ts:89-93`
- **Status:** open

When `addToTopology` processes a fork agent, it sets targets to `existingIds` + "parent", excluding other new agents in the same batch. Meanwhile, `group.ts:155-160` builds the fork's `allChannels` from `this.entries`, which includes same-batch agents pushed in earlier loop iterations. The system prompt advertises those agents as reachable peers, but the broker's topology prevents sending to them. Currently unreachable through the tool interface (fork adds a single agent, subagent creates only regular agents), but the function's contract promises "parent-equivalent access" for forks, which would break if `start()` were ever called with a mixed batch containing forks.

### 4. Dead `formatTokenCount` in index.ts

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/index.ts:943-948`
- **Status:** resolved

`formatTokenCount` is defined at the bottom of `index.ts` but never called. Its only consumer (`aggregateUsage`) was removed in this diff. The identical function in `group.ts:535` is the one actually used.

**Resolution:** Deleted the dead `formatTokenCount` function from index.ts.

## No Issues

Plan adherence: no other significant deviations found beyond finding #1. All five steps were implemented as specified — reasonable adaptations were made during implementation but none drifted from the plan's intent.
