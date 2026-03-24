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
