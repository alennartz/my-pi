# Plan: Dynamic Group Membership

## Context

The subagents extension enforces one active group with fixed membership — agents can't be added or removed after spawn. This blocks workflows where an agent wants to fork or spawn additional subagents while others are already running. See [brainstorm](../brainstorms/dynamic-group-membership.md).

## Architecture

### Impacted Modules

**Subagents Extension (`index.ts`)**

The "active group" gating goes away. `SubagentManager` is instantiated once at extension init and lives for the extension's lifetime. `subagent` and `fork` tools call `manager.start(specs)` — no conditional on whether agents are already running. `teardown_group` becomes `teardown` with an optional `agent` parameter. `<group_idle>` notification and `serializeGroupIdle` usage removed entirely. `fork` tool gains a required `id` parameter. Prompt guidelines and tool descriptions reworded to drop group framing.

**Group Manager (`group.ts`) → Subagent Manager**

Renamed to reflect that there's no "group" concept. `SubagentManager` is long-lived — constructed once, manages broker and widget infrastructure lazily. Exposes two methods:

- `start(specs[], ...)` — adds agents. Starts broker/widget on first call, subsequent calls just add agents to existing infrastructure. Handles per-agent setup: build args, create RpcChild, wire events, monitor exit, send initial prompt. Extends topology.
- `teardown(id?)` — no arg kills all agents and tears down infrastructure. With `id`, kills that one agent, removes from topology/entries, updates widget. When last agent is removed, tears down infrastructure automatically.

The `<group_idle>` check (`checkGroupIdle`) is removed. Per-agent completion notifications (`onAgentComplete`) remain.

**Channels (`channels.ts`)**

New free functions `addToTopology(topology, agents, existingIds)` and `removeFromTopology(topology, id)` that mutate the topology map in place. `addToTopology` adds new agents' channel entries and adds them to parent's target set. For fork specs, channels are set to all existing agent IDs + parent. `removeFromTopology` deletes the agent's entry and removes it from all other agents' target sets (including parent's).

**Broker (`broker.ts`)**

Topology removal support: when an agent is intentionally removed (not crashed), the broker needs to reject future sends to it. Today `agentDied` uses a `failedAgents` set. This set becomes `removedAgents` (or just `deadAgents`) covering both crash and intentional removal. The synthetic error message distinguishes the two cases: "agent crashed" vs "agent was removed." The broker also needs the topology reference to be the same mutable map managed by SubagentManager — it already holds a reference, so mutations to the map are visible to `canSend` automatically.

**Messages (`messages.ts`)**

`serializeGroupIdle` and its `GroupIdleData` type are removed. `serializeGroupComplete` stays for the all-agents teardown report. A single-agent teardown returns that agent's `AgentCompleteData` directly.

**Widget (`widget.ts`)**

No structural changes. Already re-renders from the full status list on every update — agents appearing and disappearing is handled naturally.

### Interfaces

**`SubagentManager` API:**

- `start(agents: AgentSpec[], agentConfigs: AgentConfig[], ...) → Promise<string>` — returns acknowledgment text. First call starts infrastructure; subsequent calls add agents.
- `teardown(agentId?: string) → Promise<{ report: string; empty: boolean }>` — returns the completion report and whether infrastructure was torn down (no agents left). Caller uses `empty` to clean up widget reference and parent broker client.
- `getAgentStatus(id)`, `getAgentStatuses()` — unchanged.
- Constructor takes the stable dependencies (pi, cwd, callbacks) that don't change per-spawn. Per-spawn details (specs, configs, topology extensions) go through `start()`.

**Topology mutations:**

- `addToTopology(topology: Topology, agents: AgentChannelSpec[], existingIds: Set<string>, forkIds: Set<string>): void` — mutates topology. `forkIds` identifies which new agents get parent-equivalent access (all existing IDs as channels).
- `removeFromTopology(topology: Topology, agentId: string): void` — removes agent's entry and removes it from all other agents' target sets.

**`teardown` tool schema:**

```
parameters: {
  agent: Optional<String>  // Agent id to remove. Omit to tear down all agents.
}
```

**`fork` tool schema change:**

```
parameters: {
  id: String,    // NEW — required
  task: String
}
```

## Steps

**Pre-implementation commit:** `3e1b8cce8d9e3ff78517793cff203735121aea33`

### Step 1: Add topology mutation functions to channels.ts

Add two new exported functions to `extensions/subagents/channels.ts`:

**`addToTopology(topology: Topology, agents: AgentChannelSpec[], existingIds: Set<string>, forkIds: Set<string>): void`** — Mutates topology in place. For each new agent: if the agent's id is in `forkIds`, set their targets to all `existingIds` + `"parent"` (parent-equivalent access); otherwise, set targets to their declared `channels` + `"parent"` (same logic as `buildTopology`). Add all new agent IDs to the parent's target set. Does not modify existing agents' target sets.

Validate before mutating: new agents' declared channels must reference either existing IDs or other new IDs in the batch. Throw on violation.

**`removeFromTopology(topology: Topology, agentId: string): void`** — Deletes the agent's entry from the map. Iterates all remaining entries and removes `agentId` from their target sets (including parent's).

**Verify:** Functions exported. `addToTopology` extends topology for regular and fork agents without touching existing agents' entries. `removeFromTopology` cleans all references. Existing `buildTopology`, `validateTopology`, `canSend` unchanged.
**Status:** done

### Step 2: Expand broker dead agent handling for intentional removal

In `extensions/subagents/broker.ts`:

- Replace `failedAgents: Set<string>` with `removedAgents: Map<string, "crashed" | "removed">` — tracks both crash and intentional removal with the reason.
- Rename `agentDied(id)` to `agentCrashed(id)` — same cleanup logic (resolve pending correlations, clean deadlock graph, close socket) but stores reason `"crashed"`. Synthetic error message: `Agent "X" has crashed and cannot receive messages`.
- Add `agentRemoved(id: string)` — same cleanup as `agentCrashed` but stores reason `"removed"`. Synthetic error message: `Agent "X" was removed`.
- Update `handleSend` dead agent check to read from `removedAgents` map and include the reason-specific message.

**Verify:** Both `agentCrashed` and `agentRemoved` callable. Sends to crashed agents get "crashed" error, sends to removed agents get "removed" error. Pending correlations cleaned up in both paths.
**Status:** done

### Step 3: Remove group_idle serialization from messages.ts

In `extensions/subagents/messages.ts`:

- Delete the `GroupIdleData` interface.
- Delete the `serializeGroupIdle` function.

Leave `GroupCompleteData`, `serializeGroupComplete`, `AgentCompleteData`, `serializeAgentComplete` intact.

**Verify:** No exports of `GroupIdleData` or `serializeGroupIdle`. All other serializers present and unchanged.
**Status:** done

### Step 4: Rename GroupManager → SubagentManager and restructure for long-lived use

In `extensions/subagents/group.ts`:

**Rename:** `GroupManager` → `SubagentManager`, `GroupManagerOptions` → `SubagentManagerOptions`.

**Restructure constructor.** Options become stable, per-lifetime deps only:
```typescript
interface SubagentManagerOptions {
    pi: PiAPI;
    cwd: string;
    skillPaths: string[];
    resolveContextWindow: (modelId: string) => number | undefined;
    onUpdate: () => void;
    onAgentComplete: (agentId: string) => void;
    onParentMessage: (xml: string, meta: MessageMeta) => void;
}
```
No `agents`, `agentConfigs`, or `topology` in constructor.

**Restructure `start()`.** New signature: `start(agents: AgentSpec[], agentConfigs: AgentConfig[]): Promise<string>`.
- **First call:** Creates session dir, builds topology via `buildTopology(specs)`, stores as `this.topology`, creates and starts Broker (passing `this.topology` reference), spawns RPC children, monitors exits, sends initial prompts.
- **Subsequent calls:** Extends `this.topology` via `addToTopology(this.topology, newSpecs, existingIds, forkIds)` where `existingIds` is the set of current agent IDs and `forkIds` is derived from specs with `kind === "fork"`. Spawns new RPC children into existing infrastructure. No new broker — the existing broker sees topology mutations through the shared reference.
- Both paths: build RPC children, subscribe to events, send initial task prompts, monitor exits. Return acknowledgment text.

**Add `teardown(id?: string): Promise<{ report: string; empty: boolean }>`.**
- **Without `id`:** Stop all RPC children, call `broker.stop()`, clean session dir, clear entries and topology. Return `serializeGroupComplete(...)` report. `empty: true`.
- **With `id`:** Find entry by id (throw if missing). Stop that agent's RPC child. Call `broker.agentRemoved(id)`. Call `removeFromTopology(this.topology, id)`. Remove from entries. If entries is now empty, tear down infrastructure (broker, session dir). Return `serializeAgentComplete(...)` report. `empty` reflects whether infrastructure was torn down.

**Remove:** `checkGroupIdle` method, `onGroupIdle` from options interface, all `checkGroupIdle()` call sites (in `monitorExit` and `handleRpcEvent`).

**Remove old `destroy()` method** — replaced by `teardown()`.

**Retain:** `onAgentComplete` per-agent notifications, `getAgentStatus`, `getAgentStatuses`, `correlationToTarget` tracking.

**Verify:** Class renamed. Constructor takes only stable deps. `start()` works on first and subsequent calls (first creates infrastructure, subsequent extend it). `teardown()` works with and without id. No references to `checkGroupIdle`, `onGroupIdle`, or `destroy`.
**Status:** done

### Step 5: Rewire tools, remove gating, and update guidelines in index.ts

In `extensions/subagents/index.ts`:

**Instantiate SubagentManager once** at extension init (inside `session_start` or lazily on first tool use). Construct with the stable deps: `pi`, `cwd`, `skillPaths`, `resolveContextWindow`, `onUpdate`, `onAgentComplete`, `onParentMessage`. Remove the per-spawn `startGroup` helper entirely — its dashboard/widget setup moves to a lazy-init path (create widget on first `start()` call if not yet created).

**Remove active group gating.** Delete `activeGroup` variable and the `if (activeGroup) throw` check. The subagent tool calls `manager.start()` directly.

**Update subagent tool execute handler.** Builds `AgentSpec[]` and `AgentConfig[]` from tool input, calls `manager.start(specs, configs)`. Topology building and validation now happen inside SubagentManager. Returns acknowledgment from `start()`.

**Update fork tool schema.** Add required `id: string` parameter alongside `task`. Execute handler builds a `ForkAgentSpec` with the user-provided id, calls `manager.start([forkSpec], [forkConfig])`.

**Rename `teardown_group` tool → `teardown`.** Schema gains optional `agent: string` parameter. Execute handler calls `manager.teardown(agentId?)`. When returned `empty` is true, clean up widget reference and parent broker client. When `agent` is provided, return the single-agent report; otherwise return the all-agents report.

**Remove group_idle.** Delete `serializeGroupIdle` import. Delete `onGroupIdle` callback from manager setup. Remove any group_idle notification queueing.

**Update prompt guidelines.** Reword the `promptGuidelines` string to drop "group" framing:
- "One active group at a time" → agents can be added incrementally
- `teardown_group` references → `teardown` with optional agent targeting
- `fork` → now requires an `id` parameter
- Group idle guidance → removed (no more `<group_idle>` notifications)
- Idle groups concept → agents persist until explicitly torn down

**Collapse startGroup.** The `startGroup` helper is absorbed into the subagent tool's execute handler (or a thinner helper). Widget/dashboard setup moves to first-use initialization.

**Verify:** No `activeGroup` variable. No `serializeGroupIdle` import. No `startGroup` helper. SubagentManager instantiated once. `subagent` tool adds agents without gating. `fork` tool requires `id`. `teardown` tool replaces `teardown_group` with optional `agent` param. Prompt guidelines reference new semantics.
**Status:** not started
