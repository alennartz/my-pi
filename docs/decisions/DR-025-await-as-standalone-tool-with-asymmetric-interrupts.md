# DR-025: Await as Standalone Tool with Asymmetric Interrupt Semantics

## Status
Accepted

## Context
The subagent system needed a way for the parent to block until spawned agents complete. Two axes of design: (1) how to expose the capability — as an `await` parameter on the `subagent` tool (atomic spawn-and-wait) or as a separate `await_agents` tool, and (2) how different event types interact with the wait — whether agent completions and parent-bound messages resolve it the same way or differently.

The existing notification system delivered `<agent_complete>` and `<agent_message>` events asynchronously between tool calls. There was no way for the parent to say "I have nothing useful to do until these agents finish" — it had to either busy-loop with `check_status` or hope notifications arrived at convenient times.

## Decision
`await_agents` is a standalone tool, decoupled from `subagent`. Completions accumulate — the wait only resolves when all scoped agents are idle or failed. Parent-bound messages (both fire-and-forget and expect-response) interrupt the wait immediately, regardless of how many agents are still running. After handling an interrupting message, the parent re-calls `await_agents` to resume waiting.

**Standalone tool over parameter:** Decoupling spawn from wait lets the parent do useful work between them — read files, spawn more agents, set up context — then block only when it actually needs results. The `await` parameter becomes trivial sugar (spawn then immediately wait) that can be layered on later. Coupling them would have been simpler to use but would force a choice: either the parent commits to waiting at spawn time, or it doesn't wait at all.

**Asymmetric resolution:** Expect-response messages *must* interrupt — the agent is blocked waiting for a response, and the parent is blocked on the wait, so not interrupting means deadlock. Fire-and-forget messages also interrupt because if an agent sent something during a wait, the parent should handle it promptly rather than accumulating it silently for later. This makes the parent noisier (it may need to re-wait multiple times) but keeps it informed. The alternative — only interrupting on expect-response — would be quieter but risks the parent missing time-sensitive information from agents.

## Consequences
- The parent must handle the re-wait pattern: call `await_agents`, handle any interrupting message, call `await_agents` again. This adds prompt complexity — the model needs guidance on the pattern.
- Fire-and-forget messages during a wait cause early returns even when the parent didn't ask for them. If agents are chatty, this could cause many re-waits. In practice, agents rarely send fire-and-forget to parent during normal operation.
- The `await` parameter on `subagent` is a natural follow-up but isn't needed yet — the primitive is sufficient.
- Completions from agents outside the scoped set are accumulated but don't satisfy the wait condition, preserving the scoping semantics without losing events.
