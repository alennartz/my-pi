# Wait-for-Agents Tool

## The Idea

Add a `wait_for_agents` tool that blocks until something interesting happens in the agent group — an agent completes, or an agent sends a message to the parent. This is a standalone primitive, separate from the `subagent` spawn tool.

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

### No buffer needed

The wait tool is an open tool call. When an event triggers, it resolves the tool call with the XML content directly as the tool result. The pi SDK sequences tool results correctly — no intermediate buffer, no flush mode switching, no interaction with the existing notification queue. Events that arrive while the wait is open resolve the promise; events before the wait call were already delivered normally.

## Direction

Implement `wait_for_agents` as a new tool in the subagents extension:

1. Tool schema: optional `agent` parameter (string, single agent ID). Omit to wait on all.
2. When called, register a listener for agent_complete events and parent-bound messages.
3. On any such event, resolve the tool call with the XML content.
4. The parent gets full context: any completed agent results plus the event that triggered the return.
5. After the `wait_for_agents` primitive exists, optionally add `await` as sugar on the `subagent` tool (spawn → immediately wait).

## Open Questions

- Should the wait tool accept an array of agent IDs for partial-group waits, or is single-agent-or-all sufficient to start?
- When wait returns due to an interrupting message, should the prompt guidance tell the model to re-call wait after handling it, or leave that to the model's judgment?
- Stop sequences: the existing `<agent_complete` stop sequence prevents the model from hallucinating completions during the async gap. With the wait tool active, there's no gap — but should the stop sequence still be added as a safety net?
