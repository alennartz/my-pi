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

- **`index.ts`** — Entry point. Role detection, tool registration (`subagent`, `send`, `respond`, `check_status`). Root registers all four tools with `promptGuidelines` carrying the protocol spec. Children register all four tools identically (recursive subagents allowed). Per-child identity (id, channels, task) is injected via `--append-system-prompt`, not via tool registration.
- **`agents.ts`** — Agent discovery. Forked from the example extension's `agents.ts`, extended with a `skills` field in `AgentConfig`. Skills field contains skill names; resolved to paths at spawn time via `pi.getCommands()`. When `skills` is omitted, child gets the default skill set. When present, child is spawned with `--no-skills --skill <path>` per skill.
- **`group.ts`** — Group lifecycle. Spawns `pi --mode rpc` child processes via `RpcClient`. One active group at a time — spawning a second group while one is active returns an error. Manages per-agent state (running/waiting/done/failed). Subscribes to each child's RPC event stream for widget updates and message routing. On group completion (all agents done/failed), steers XML summary into parent conversation via `pi.sendMessage({ deliverAs: "steer" })` and clears the widget.
- **`channels.ts`** — Topology enforcement and message routing. Validates topology at spawn time: all channel references must point to existing agent ids in the group; disconnected agents (empty channels) are allowed. At runtime, `send` tool checks caller's channel list before routing — rejects sends to peers not in the list. Parent (`"parent"`) is auto-injected into every agent's channel list; the `channels` field in the `subagent` tool is purely agent-to-agent. Parent can send to any agent in the group.
- **`deadlock.ts`** — Directed graph of pending blocking `send` calls. Each edge: agent A is blocked waiting for agent B. Before routing a blocking send from A to B, adds tentative edge A→B and walks from B looking for A (cycle detection via DFS). If cycle found, rejects the send with an error result. Edges removed when `respond` resolves or target agent dies (synthetic error response). Graph is per extension instance — child extensions maintain their own graph for their sub-groups. Cross-level deadlocks are caught at each level independently.
- **`messages.ts`** — Structured message format. Serialization/deserialization for inter-agent messages and group completion reports, both in XML.

  Inter-agent message format (injected via RPC `steer` into receiver's conversation):
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

Fire-and-forget (default): delivers message via RPC `steer`, returns immediately.
Blocking (`expectResponse: true`): holds tool execution open until receiver calls `respond`, returns the response as tool result.

Channel enforcement in code: rejects sends to peers not in caller's channel list. Parent is always allowed.

Deadlock check before routing blocking sends: if adding edge would create a cycle, rejects with error.

**`respond` tool parameters:**

```typescript
respond({
  correlationId: string,     // from incoming message's correlation_id attribute
  message: string,           // response content
})
```

Resolves the blocked `send` on the sender's side. Errors if correlation ID doesn't match a pending request.

**`check_status` tool parameters:**

```typescript
check_status({
  agent: string,             // required — agent id to query
})
```

Returns detailed status for a specific agent: state, current tool activity, usage stats, pending correlation IDs.

**Protocol knowledge delivery:**

- Root agent and children: `promptGuidelines` on `send`, `respond`, `subagent` tools carries the protocol spec (XML message format, blocking vs fire-and-forget patterns, broadcast via multiple concurrent sends).
- Children only: `--append-system-prompt <file>` carries per-agent identity (id, channel list, task). No protocol duplication — guidelines handle the protocol, append handles identity.

**Synthetic error responses:**

If a child process exits (crash, normal exit, abort) while correlation IDs are pending against it, the extension generates synthetic error responses back to all blocked senders. Delivered as tool results resolving the blocked `send` calls with error text.

### Technology Choices

**RPC subprocess (`pi --mode rpc`) over in-process AgentSession SDK.**

Both provide identical communication primitives (`steer`/`followUp`/events). RPC was chosen for:

1. Process isolation — child crash/OOM/hang doesn't take down the parent. Critical for agents doing arbitrary work (bash commands, file edits).
2. Zero-config child setup — `pi --mode rpc` with CLI flags gives a fully-functional agent. AgentSession requires ~30 lines of manual wiring per child (ResourceLoader, AuthStorage, ModelRegistry, SessionManager, SettingsManager, tools, extensions).
3. Natural recursive subagents — child processes load the same extension automatically.
4. Clean lifecycle — process exit is cleanup, no manual `dispose()` tracking.

Tradeoffs accepted: higher memory per child (separate V8 heap), 1-2s startup latency per child, all extensions load in children (harmless — unused extensions are inert). These are acceptable because LLM API latency dwarfs startup time and groups are small/temporary.

The `RpcClient` typed client from `@mariozechner/pi-coding-agent` handles the JSON protocol. If memory/startup becomes a problem with large groups in v2, AgentSession exists as an optimization path — the communication model is identical, it's a transport change.
