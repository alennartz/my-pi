# Agent Coordination

Use this reference when agents need peer channels, messages, waits, or blocking requests.

## Topology

Start with the smallest topology.

- The parent is always available. Do not declare a parent channel.
- Declare peer channels only for real lateral communication.
- More channels create more noise and invite unnecessary messages.

Channel references are validated when the group starts. Reference only agents that exist in the same spawn set.

## Fire-and-forget

Use the default `send` mode for status updates, heads-ups, intermediate findings, and coordination. The sender continues immediately. Do not use a fire-and-forget message as a completion signal or as a duplicate of the final response.

## Completion reporting

An agent completes its task by returning its final response and going idle. The parent receives that result through the idle notification. The agent does not need to send a separate completion message.

Let idle notifications drive completion. Do not poll status. Use `await_agents` when results must arrive before the parent continues.

## Blocking sends

Set `expectResponse=true` only when the sender cannot continue without the reply. The call stays open until the target responds with the matching correlation id.

Use blocking sends for:

- a question that gates the sender's next action;
- a scatter-gather query that needs all perspectives; or
- synchronous coordination where continuing would produce invalid work.

For scatter-gather, send to all targets in the same turn so the requests run concurrently.

## Deadlock awareness

Blocking dependencies must form an acyclic graph. The broker rejects a send that creates a cycle.

Safe forms include:

- **Unidirectional blocking:** one agent waits for another, which never waits back.
- **Parent mediation:** agents wait on the parent, and the parent waits on agents.
- **Mixed coordination:** peer messages use fire-and-forget while blocking waits point toward the parent.

Avoid a blocking ring. If an agent can continue without a reply, use fire-and-forget instead.
