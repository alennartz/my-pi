# Plan: Subagents

## Context

Build a group-based subagent extension with channel-based inter-agent communication over pi's RPC mode. The extension handles topology enforcement, deadlock detection, and message routing in code. The TUI shows live group state via a widget. Recursive subagents are allowed but nested TUI visibility is deferred to v2. See [docs/brainstorms/subagents.md](../brainstorms/subagents.md).

## Architecture

### Impacted Modules

**Components** — No changes. The widget is extension-specific, not reusable across extensions.

**Workflow Extension** — No changes. Subagents and the workflow pipeline are independent. A workflow phase could use subagents, but that's a user choice via prompt, not a structural coupling.

**Docs** — No changes to existing artifacts or decision records.

### New Modules

**Subagents Extension** (`extensions/subagents/`)

A multi-file extension that spawns and orchestrates groups of subagent processes. Runs at every level (root and children), detecting its role to register appropriate behavior.

Responsibilities: group lifecycle management, RPC child process spawning, channel-based topology enforcement, inter-agent message routing, deadlock detection, structured message formatting, agent discovery (extended with skills field), TUI widget rendering, group completion delivery.

Dependencies: `@mariozechner/pi-coding-agent` (ExtensionAPI, RpcClient, tool registration, widget API, promptGuidelines), `@mariozechner/pi-ai` (StringEnum).

Internal modules:

- **`index.ts`** — Entry point. Role detection via `PI_SUBAGENT` env var. Root (no env var): starts the message broker (`broker.ts`), registers all four tools (`subagent`, `send`, `respond`, `check_status`) with `promptGuidelines` carrying the protocol spec. Children (env var present): parse the JSON payload for identity (`{ id, channels, task, brokerSocket }`), connect to the parent's broker unix socket, register all four tools identically (recursive subagents allowed — children start their own broker for sub-groups).
- **`agents.ts`** — Agent discovery. Forked from the example extension's `agents.ts`, extended with a `skills` field in `AgentConfig`. Skills field contains skill names; resolved to paths at spawn time via `pi.getCommands()`. When `skills` is omitted, child gets the default skill set. When present, child is spawned with `--no-skills --skill <path>` per skill.
- **`group.ts`** — Group lifecycle. Spawns `pi --mode rpc` child processes via `RpcClient`, setting `PI_SUBAGENT` env var on each child with a JSON payload containing `{ id, channels, task, brokerSocket }`. The `brokerSocket` field is the path to the parent's unix socket. One active group at a time — spawning a second group while one is active returns an error. Manages per-agent state (running/waiting/done/failed). Subscribes to each child's RPC event stream for widget updates. On group completion (all agents done/failed), steers XML summary into parent conversation via `pi.sendMessage()` and clears the widget.
- **`broker.ts`** — Unix socket message broker running in the parent process. Hub-and-spoke topology: all children connect on startup, all inter-agent messages route through the broker. Responsibilities: channel enforcement (rejects sends to peers not in sender's channel list, using topology from `channels.ts`), deadlock detection (via `deadlock.ts`), message forwarding (writes validated messages to the target child's socket connection), blocking send correlation (holds pending correlation IDs, resolves when `respond` arrives or target dies), parent-as-receiver (messages addressed to `"parent"` are delivered into the parent's own conversation via `pi.sendMessage()`). Children never communicate directly with each other — the broker is the sole routing authority. Socket created at a temp path on group spawn, cleaned up on group completion.
- **`channels.ts`** — Topology validation at spawn time: all channel references must point to existing agent ids in the group; disconnected agents (empty channels) are allowed. Parent (`"parent"`) is auto-injected into every agent's channel list; the `channels` field in the `subagent` tool is purely agent-to-agent. Parent can send to any agent in the group. Runtime channel enforcement is performed by the broker, using the topology defined here.
- **`deadlock.ts`** — Directed graph of pending blocking `send` calls, maintained by the broker. Each edge: agent A is blocked waiting for agent B. Before routing a blocking send from A to B, adds tentative edge A→B and walks from B looking for A (cycle detection via DFS). If cycle found, rejects the send with an error result. Edges removed when `respond` resolves or target agent dies (synthetic error response). Graph is per broker instance — recursive subagents run their own broker with their own graph. Cross-level deadlocks are caught at each level independently.
- **`messages.ts`** — Structured message format. Serialization/deserialization for inter-agent messages and group completion reports, both in XML. Messages are delivered locally at the receiver: the broker forwards the serialized message over the target child's socket connection, and the child's extension injects it into its own conversation via `pi.sendMessage()`.

  Inter-agent message format:
  ```xml
  <agent_message from="scout" correlation_id="abc-123" response_expected="true">
  Found 3 authentication providers. Should I investigate OAuth specifically?
  </agent_message>
  ```
  - `from`: sender's id within the group, or `"parent"`
  - `correlation_id`: present only when `response_expected="true"`
  - `response_expected`: `"true"` or `"false"`

  Group completion format (steered into parent's conversation when all agents finish):
  ```xml
  <group_complete>
    <summary>3 done, 1 failed</summary>
    <agent id="scout" status="done">
      <output>Found 3 auth providers in src/auth/...</output>
    </agent>
    <agent id="reviewer" status="failed">
      <error>Process exited with code 1</error>
    </agent>
    <usage input="50k" output="12k" cost="$0.45" />
  </group_complete>
  ```

- **`widget.ts`** — TUI widget rendering via `ctx.ui.setWidget("subagents", ...)`. Compact display: one line per agent showing id, status icon (⏳ running / ✓ done / ✗ failed / ⏸ waiting), current activity (last tool call), usage stats. Communication state shown when agent is blocked ("waiting for response from X"). Aggregate line with total cost/tokens. Updates in real-time from RPC event streams. Clears on group completion.

### Interfaces

**`subagent` tool parameters:**

```typescript
subagent({
  agents: [
    {
      id: string,              // unique within this group
      agent?: string,          // agent definition name (optional — omit for default agent)
      task: string,            // task description
      channels?: string[],     // peer agent ids this agent can send to (agent-to-agent only)
    }
  ],
  agentScope?: "user" | "project" | "both",   // where to discover agent .md files (default: "user")
  confirmProjectAgents?: boolean,              // prompt before running project-local agents (default: true)
})
```

Non-blocking — returns immediately with acknowledgment. Live state displayed via widget. One active group at a time; returns error if a group is already running.

Parent is auto-injected into every agent's channel list. The `channels` field governs agent-to-agent peer communication only.

Topology validated at spawn: all channel references must resolve to agent ids in the group. Disconnected agents (no channels) are allowed.

**`send` tool parameters:**

```typescript
send({
  to: string,                // target agent id or "parent"
  message: string,           // message content
  expectResponse?: boolean,  // default false (fire-and-forget)
})
```

Fire-and-forget (default): sends routing request to the parent's broker over unix socket; broker validates channels, forwards to target; target's extension self-steers via `pi.sendMessage()`. Returns immediately after broker acknowledgment.

Blocking (`expectResponse: true`): same routing path, but the tool execution is held open until the receiver calls `respond`. The broker holds the correlation and delivers the response back over the sender's socket connection.

Channel enforcement at the broker: rejects sends to peers not in sender's channel list. Parent is always allowed.

Deadlock check at the broker before routing blocking sends: if adding the pending edge would create a cycle, rejects with error.

**`respond` tool parameters:**

```typescript
respond({
  correlationId: string,     // from incoming message's correlation_id attribute
  message: string,           // response content
})
```

Sends the response to the broker over unix socket. The broker resolves the blocked `send` on the sender's side by delivering the response over the sender's socket connection. Errors if correlation ID doesn't match a pending request.

**`check_status` tool parameters:**

```typescript
check_status({
  agent: string,             // required — agent id to query
})
```

Returns detailed status for a specific agent: state, current tool activity, usage stats, pending correlation IDs.

**Protocol knowledge delivery:**

- Root agent and children: `promptGuidelines` on `send`, `respond`, `subagent` tools carries the protocol spec (XML message format, blocking vs fire-and-forget patterns, broadcast via multiple concurrent sends).
- Children only: `--append-system-prompt <file>` carries per-agent identity (id, channel list, task) for the LLM. The same identity data is passed programmatically to the extension code via the `PI_SUBAGENT` env var (JSON: `{ id: string, channels: string[], task: string, brokerSocket: string }`), which the extension uses to connect to the parent's broker for message routing and channel enforcement. No protocol duplication — guidelines handle the protocol, append handles LLM-facing identity, env var handles extension-facing identity.

**Synthetic error responses:**

If a child process exits (crash, normal exit, abort) while correlation IDs are pending against it, the broker generates synthetic error responses back to all blocked senders. Delivered over the sender's socket connection, resolving the blocked `send` tool calls with error text.

### Technology Choices

**RPC subprocess (`pi --mode rpc`) over in-process AgentSession SDK.**

Both provide identical communication primitives (`steer`/`followUp`/events). RPC was chosen for:

1. Process isolation — child crash/OOM/hang doesn't take down the parent. Critical for agents doing arbitrary work (bash commands, file edits).
2. Zero-config child setup — `pi --mode rpc` with CLI flags gives a fully-functional agent. AgentSession requires ~30 lines of manual wiring per child (ResourceLoader, AuthStorage, ModelRegistry, SessionManager, SettingsManager, tools, extensions).
3. Natural recursive subagents — child processes load the same extension automatically.
4. Clean lifecycle — process exit is cleanup, no manual `dispose()` tracking.

Tradeoffs accepted: higher memory per child (separate V8 heap), 1-2s startup latency per child, all extensions load in children (harmless — unused extensions are inert). These are acceptable because LLM API latency dwarfs startup time and groups are small/temporary.

The `RpcClient` typed client from `@mariozechner/pi-coding-agent` handles the JSON protocol. If memory/startup becomes a problem with large groups in v2, AgentSession exists as an optimization path — the communication model is identical, it's a transport change.

**Unix socket message broker over pi's RPC channel for inter-agent messaging.**

Pi's RPC protocol is a closed set of commands and events — no custom message types can be multiplexed through it. Inter-agent messages need a separate transport. The broker uses a unix domain socket (hub-and-spoke):

1. Parent creates a unix socket at a temp path on group spawn.
2. Socket path is passed to children via the `brokerSocket` field in the `PI_SUBAGENT` env var.
3. Children connect on startup; the broker accepts and tracks connections by agent id.
4. All routing requests (`send`, `respond`) flow through the broker, which validates and forwards.
5. Receivers self-steer via `pi.sendMessage()` — delivery is always local to the receiving process.

Why hub-and-spoke over mesh (direct peer connections): deadlock detection requires a global graph of pending blocking sends. Centralizing in the broker gives a single authority for channel enforcement, deadlock checks, and agent liveness — no distributed coordination needed. Groups are small and LLM latency dwarfs the extra hop.

The RPC channel (`RpcClient`) remains in use for: spawning children, delivering the initial task prompt, subscribing to event streams for widget updates, and process lifecycle management. The unix socket handles only inter-agent messaging.

## Open Questions

These need to be resolved before implementation.

### Per-agent completion notifications

The plan references "automatic notifications (per-agent completion, group completion) steered into the parent's conversation" but only the `<group_complete>` XML format is designed. What does a per-agent completion notification look like? Is it a separate XML element steered into the parent when each child finishes? Or does the parent only learn about individual completions via the widget and `check_status`, with a single `<group_complete>` at the end?

### Agent output capture

The `<group_complete>` XML includes `<output>...</output>` per agent. How is this collected? Options: last assistant message from the RPC event stream, a dedicated output mechanism the agent calls, the full final assistant turn, or a summary. The choice affects what the parent sees in the completion report.

### Sending to a done/failed agent

What happens when `send` targets an agent that has already exited? Fire-and-forget to a dead agent — silently dropped or error result? Blocking send to an already-dead agent — immediate synthetic error? The plan covers synthetic errors for agents that die *while* a blocking send is pending, but not for sends initiated *after* death.

### Group cancellation

No `cancel_group` or `stop_agent` tool exists. If the parent decides one agent found the answer and the rest are wasting tokens, there's no way to abort. Should this be a v1 tool, deferred to v2, or handled implicitly (e.g., parent sends a "stop" message and trusts the agent to comply)?

### `check_status` group-level query

`check_status` requires an `agent` id — there's no way to get a group overview in one call. Should the `agent` parameter be optional, returning a summary of all agents when omitted?

### Agent state transitions

States are listed (running/waiting/done/failed) but transitions aren't defined. Is exit code 0 = done, nonzero = failed? What about an agent that exits normally (code 0) without responding to pending messages — is it "done" or "failed"? The synthetic error response handles the sender's side, but the agent's own status in the widget and `check_status` is ambiguous.

### `subagent` tool acknowledgment format

"Returns immediately with acknowledgment" — what's in the acknowledgment? Options: just a success message, the list of spawned agent ids, the validated topology, broker readiness status. The parent LLM needs enough information to know what it can do next.

### System prompt append file contents

`--append-system-prompt <file>` carries "per-agent identity (id, channel list, task) for the LLM" but the actual content and format of this file aren't designed. This is the LLM-facing half of the protocol — it needs to tell the agent who it is, who it can talk to, and what it should do, without duplicating the tool-level `promptGuidelines`.

### Minor

- **Temp file lifecycle**: Where is the `--append-system-prompt` temp file created and when is it cleaned up?
- **`agentScope` discovery paths**: Behavior borrowed from the example extension but not re-specified here. Where are user vs. project agent `.md` files discovered?
- **`promptGuidelines` wording**: The actual text of the protocol spec delivered via `promptGuidelines` on the tools — scatter-gather, broadcast, fire-and-forget patterns, XML message format recognition, when to use `respond` vs. fire-and-forget `send`.
