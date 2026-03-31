# Wait-for-Agents Tool

## The Idea

Add a `wait_for_agents` tool that blocks until all scoped agents have completed, or until an agent sends a message to the parent (which interrupts the wait immediately). Agent completions accumulate — the wait only resolves when every scoped agent is idle or failed. Parent-bound messages are different: they interrupt and resolve the wait right away, regardless of how many agents are still running. This is a standalone primitive, separate from the `subagent` spawn tool.

The original idea ([blocking-subagent-await](../ideas/blocking-subagent-await.md)) proposed an `await` flag on the `subagent` tool that couples spawning and waiting atomically. This variant decouples them: spawn stays async, and the parent calls `wait_for_agents` when it's ready to block. The `await` parameter can be layered on trivially later as sugar — spawn then immediately wait.

## Key Decisions

### Separate tool, not a parameter

Decoupling spawn from wait gives the parent flexibility to do useful work between them (read files, spawn more agents, set up context) and then block only when it actually needs results. It also produces a reusable primitive — the `await` parameter on `subagent` becomes a one-liner that calls spawn then wait. Build the primitive first; add the convenience second.

### Parameter structure mirrors teardown

Optional agent ID. Omit it → wait on all agents. Specify one → scope the wait to that agent. Simple, consistent with existing tool conventions.

### Any send-to-parent interrupts the wait

Both `expectResponse=true` and fire-and-forget sends interrupt the wait and return immediately. The reasoning:

- **expect-response must interrupt** — the parent is blocked, the agent is blocked waiting for a response, deadlock otherwise.
- **Fire-and-forget should also interrupt** — if an agent bothered to send something during a wait, it had a reason. Accumulating silently and delivering later defeats the purpose. The noisiness is a feature, not a problem — it means the parent stays informed about what's happening.

### Return format is concatenated XML blocks

Agent completions and messages are already serialized as XML tags (`<agent_complete>`, `<agent_message>`). The wait tool returns them concatenated with line breaks — the same format the model already handles when notifications arrive. No new format needed.

### Completions accumulate, messages interrupt

Agent completions don't resolve the wait individually — they accumulate in the notification queue. The wait only resolves when all scoped agents are idle or failed. This means if three agents are running and one completes, the wait keeps blocking until the other two finish (or a message interrupts). Parent-bound messages, on the other hand, resolve the wait immediately — the parent needs to handle them (especially expect-response messages, to avoid deadlock). After handling an interrupting message, the model re-calls `wait_for_agents` to resume waiting for the remaining agents.

## Direction

Implement `wait_for_agents` as a new tool in the subagents extension:

1. Tool schema: optional `agent` parameter (string, single agent ID). Omit to wait on all.
2. When called, register a listener for agent_complete events and parent-bound messages.
3. Agent completions accumulate in the queue. Parent-bound messages (send to parent) interrupt and resolve the wait immediately.
4. When all scoped agents are idle/failed, the wait resolves with all accumulated completions.
5. The parent gets full context: all completed agent results in one batch, or the interrupting message plus any completions that arrived before it.
6. After the `wait_for_agents` primitive exists, optionally add `await` as sugar on the `subagent` tool (spawn → immediately wait).

## Open Questions

- Should the wait tool accept an array of agent IDs for partial-group waits, or is single-agent-or-all sufficient to start?
- When wait returns due to an interrupting message, should the prompt guidance tell the model to re-call wait after handling it, or leave that to the model's judgment?
- Stop sequences: the existing `<agent_complete` stop sequence prevents the model from hallucinating completions during the async gap. With the wait tool active, there's no gap — but should the stop sequence still be added as a safety net?
