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

Dependencies: `@mariozechner/pi-coding-agent` (ExtensionAPI, tool registration, widget API, promptGuidelines), `@mariozechner/pi-ai` (StringEnum).

Internal modules:

- **`index.ts`** — Entry point. Role detection via `PI_SUBAGENT` env var. Root (no env var): starts the message broker (`broker.ts`), registers all five tools (`subagent`, `send`, `respond`, `check_status`, `teardown_group`) with `promptGuidelines` carrying the protocol spec. Children (env var present): parse the JSON payload for identity (`{ id, channels, task, brokerSocket }`), connect to the parent's broker unix socket, register all five tools identically (recursive subagents allowed — children start their own broker for sub-groups).
- **`agents.ts`** — Agent discovery. Forked from the example extension's `agents.ts`, extended with a `skills` field in `AgentConfig`. Skills field contains skill names; resolved to paths at spawn time via `pi.getCommands()`. When `skills` is omitted, child gets the default skill set. When present, child is spawned with `--no-skills --skill <path>` per skill.
- **`group.ts`** — Group lifecycle. Spawns `pi --mode rpc` child processes via `RpcChild` (a lightweight JSONL protocol wrapper in `rpc-child.ts`), setting `PI_SUBAGENT` env var on each child with a JSON payload containing `{ id, channels, task, brokerSocket }`. The `brokerSocket` field is the path to the parent's unix socket. One active group at a time — spawning a second group while one is active returns an error. Manages per-agent state (running/idle/waiting/failed). Agents in RPC mode stay alive after completing a task (idle state) and can receive new messages at any time. Subscribes to each child's RPC event stream for widget updates. Steers `<agent_complete>` to parent when each agent goes idle or fails. Steers `<group_idle>` (with inline per-agent status and usage) when all agents are idle/failed and the broker has no in-flight messages. The parent explicitly ends the group by calling `teardown_group`, which steers `<group_complete>` with the final summary, kills all processes, and clears the widget.
- **`rpc-child.ts`** — Minimal RPC protocol wrapper around `spawn('pi', ['--mode', 'rpc', ...])`. Implements JSONL framing over stdin/stdout: writes JSON commands to stdin (`prompt`, `abort`), reads JSON events and responses from stdout using LF-delimited line splitting. Exposes: `start()`, `prompt(message)`, `abort()`, `onEvent(listener)`, `stop()`, and `collectEvents()`. ~80 lines. Does not depend on the unexported `RpcClient` from `@mariozechner/pi-coding-agent` — implements the documented RPC protocol directly. The protocol is stable and documented in pi's `rpc.md`.
- **`broker.ts`** — Unix socket message broker running in the parent process. Hub-and-spoke topology: all children connect on startup, all inter-agent messages route through the broker. Responsibilities: channel enforcement (rejects sends to peers not in sender's channel list, using topology from `channels.ts`), deadlock detection (via `deadlock.ts`), message forwarding (writes validated messages to the target child's socket connection), blocking send correlation (holds pending correlation IDs, resolves when `respond` arrives or target dies), parent-as-receiver (messages addressed to `"parent"` are delivered into the parent's own conversation via `pi.sendMessage()`). Children never communicate directly with each other — the broker is the sole routing authority. Socket created at a temp path on group spawn, cleaned up on teardown. Exposes `isQuiet()` to signal when no pending correlations or in-flight messages exist (used by group.ts to detect group-idle state).
- **`channels.ts`** — Topology validation at spawn time: all channel references must point to existing agent ids in the group; disconnected agents (empty channels) are allowed. Parent (`"parent"`) is auto-injected into every agent's channel list; the `channels` field in the `subagent` tool is purely agent-to-agent. Parent can send to any agent in the group. Runtime channel enforcement is performed by the broker, using the topology defined here.
- **`deadlock.ts`** — Directed graph of pending blocking `send` calls, maintained by the broker. Each edge: agent A is blocked waiting for agent B. Before routing a blocking send from A to B, adds tentative edge A→B and walks from B looking for A (cycle detection via DFS). If cycle found, rejects the send with an error result. Edges removed when `respond` resolves or target agent dies (synthetic error response). Graph is per broker instance — recursive subagents run their own broker with their own graph. Cross-level deadlocks are caught at each level independently.
- **`messages.ts`** — Structured message format. Serialization/deserialization for inter-agent messages, per-agent completion notifications, group idle notifications, group completion reports, and subagent identity blocks — all in XML. Messages are delivered locally at the receiver: the broker forwards the serialized message over the target child's socket connection, and the child's extension injects it into its own conversation via `pi.sendMessage()`. Also defines the broker wire protocol types (JSONL, not XML) for unix socket communication.

  Inter-agent message format:
  ```xml
  <agent_message from="scout" correlation_id="abc-123" response_expected="true">
  Found 3 authentication providers. Should I investigate OAuth specifically?
  </agent_message>
  ```
  - `from`: sender's id within the group, or `"parent"`
  - `correlation_id`: present only when `response_expected="true"`
  - `response_expected`: `"true"` or `"false"`

  Per-agent completion (steered to parent when an agent goes idle or fails):
  ```xml
  <agent_complete id="scout" status="idle">
  Found 3 auth providers in src/auth/...
  </agent_complete>
  ```
  ```xml
  <agent_complete id="reviewer" status="failed">
  <error>Process exited with code 1</error>
  </agent_complete>
  ```

  Group idle notification (steered to parent when all agents are idle/failed and broker is quiet):
  ```xml
  <group_idle>
    <agent id="scout" status="idle">Found 3 auth providers in src/auth/...</agent>
    <agent id="planner" status="idle">Created implementation plan with 5 steps</agent>
    <agent id="worker" status="failed">Process exited with code 1</agent>
    <usage input="50k" output="12k" cost="$0.45" />
    All agents have finished. Send messages to continue work or call teardown_group when done.
  </group_idle>
  ```

  Group completion report (steered to parent when `teardown_group` is called):
  ```xml
  <group_complete>
    <summary>2 idle, 1 failed</summary>
    <agent id="scout" status="idle">
      <output>Found 3 auth providers in src/auth/...</output>
    </agent>
    <agent id="reviewer" status="failed">
      <error>Process exited with code 1</error>
    </agent>
    <usage input="50k" output="12k" cost="$0.45" />
  </group_complete>
  ```

  Subagent identity (passed inline via `--append-system-prompt`):
  ```xml
  <subagent_identity>
    <id>scout</id>
    <task>Find all authentication providers in the codebase.</task>

    <peers>
      <peer id="planner">Creates implementation plans</peer>
      <peer id="worker" default="true" />
      <peer id="parent">The orchestrating agent that spawned this group. It can see all agents' status and decides when the group is done. Send it questions when you need human-level judgment or decisions that affect the whole group.</peer>
    </peers>

    <protocol>
      When you receive a message from another agent, it appears as:
      <agent_message from="planner" correlation_id="abc-123" response_expected="true">
      message content
      </agent_message>

      If response_expected="true", you MUST call the respond tool with that correlation_id.
      If response_expected="false", the message is informational — no response needed.
    </protocol>
  </subagent_identity>
  ```

- **`widget.ts`** — TUI widget rendering via `ctx.ui.setWidget("subagents", ...)`. Compact display: one line per agent showing id, status icon (⏳ running / ✓ idle / ✗ failed / ⏸ waiting), current activity (last tool call), usage stats. Communication state shown when agent is blocked ("waiting for response from X"). Aggregate line with total cost/tokens. Updates in real-time from RPC event streams. Clears on teardown.

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

Sends to a failed agent (process crashed) return an error immediately — both fire-and-forget and blocking.

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
  agent?: string,            // optional — agent id to query. Omit for group summary.
})
```

When `agent` is provided: returns detailed status for that agent (state, current tool activity, usage stats, pending correlation IDs). When omitted: returns summary of all agents.

**`teardown_group` tool parameters:**

```typescript
teardown_group({})           // no parameters
```

Ends the current agent group. Kills all child processes, steers `<group_complete>` with final summary and usage into the parent's conversation, clears the widget. Returns confirmation text.

**Protocol knowledge delivery:**

- Root agent and children: `promptGuidelines` on `send`, `respond`, `subagent` tools carries the protocol spec (XML message format, blocking vs fire-and-forget patterns, broadcast via multiple concurrent sends).
- Children only: `--append-system-prompt <text>` carries per-agent identity as inline XML (the `<subagent_identity>` block — no temp files). The same identity data is passed programmatically to the extension code via the `PI_SUBAGENT` env var (JSON: `{ id: string, channels: string[], task: string, brokerSocket: string }`), which the extension uses to connect to the parent's broker for message routing and channel enforcement. No protocol duplication — guidelines handle the protocol, append handles LLM-facing identity, env var handles extension-facing identity.

**Agent states:**

- **running** — agent is actively processing (between `agent_start` and `agent_end` events)
- **idle** — agent finished current work, process alive, can receive new messages at any time
- **waiting** — agent has a pending blocking send
- **failed** — process crashed (nonzero exit, unexpected death). Terminal state.

Transitions: running→idle (agent_end), running→failed (process crash), idle→running (receives message, new turn), running→waiting (blocking send), waiting→running (response received or error).

**Synthetic error responses:**

If a child process exits (crash) while correlation IDs are pending against it, the broker generates synthetic error responses back to all blocked senders. Delivered over the sender's socket connection, resolving the blocked `send` tool calls with error text.

**Group lifecycle:**

Agents in RPC mode stay alive after completing a task. They can receive messages and start new turns at any time while idle. The group ends only when the parent explicitly calls `teardown_group`. Notifications steered to the parent during the group's lifetime:

1. `<agent_complete>` — per agent, when it goes idle or fails. Includes last assistant message as output.
2. `<group_idle>` — when all agents are idle/failed and the broker has no in-flight messages. Includes inline per-agent status and usage. The parent can send more messages to agents or call `teardown_group`.

### Technology Choices

**RPC subprocess (`pi --mode rpc`) over in-process AgentSession SDK.**

Both provide identical communication primitives (`steer`/`followUp`/events). RPC was chosen for:

1. Process isolation — child crash/OOM/hang doesn't take down the parent. Critical for agents doing arbitrary work (bash commands, file edits).
2. Zero-config child setup — `pi --mode rpc` with CLI flags gives a fully-functional agent. AgentSession requires ~30 lines of manual wiring per child (ResourceLoader, AuthStorage, ModelRegistry, SessionManager, SettingsManager, tools, extensions).
3. Natural recursive subagents — child processes load the same extension automatically.
4. Clean lifecycle — process exit is cleanup, no manual `dispose()` tracking.
5. Long-lived agents — RPC mode keeps the process alive after task completion, enabling multi-round communication without resurrection logic.

Tradeoffs accepted: higher memory per child (separate V8 heap), 1-2s startup latency per child, all extensions load in children (harmless — unused extensions are inert). These are acceptable because LLM API latency dwarfs startup time and groups are small/temporary.

A lightweight `RpcChild` wrapper in the extension implements the documented JSONL protocol directly over `spawn('pi', ['--mode', 'rpc', ...])` stdin/stdout — `RpcClient` from `@mariozechner/pi-coding-agent` is not publicly exported and cannot be used from extensions. The wrapper is ~80 lines covering `prompt`, `abort`, event streaming, and process lifecycle. If memory/startup becomes a problem with large groups in v2, AgentSession exists as an optimization path — the communication model is identical, it's a transport change.

**Unix socket message broker over pi's RPC channel for inter-agent messaging.**

Pi's RPC protocol is a closed set of commands and events — no custom message types can be multiplexed through it. Inter-agent messages need a separate transport. The broker uses a unix domain socket (hub-and-spoke):

1. Parent creates a unix socket at a temp path on group spawn.
2. Socket path is passed to children via the `brokerSocket` field in the `PI_SUBAGENT` env var.
3. Children connect on startup; the broker accepts and tracks connections by agent id.
4. All routing requests (`send`, `respond`) flow through the broker, which validates and forwards.
5. Receivers self-steer via `pi.sendMessage()` — delivery is always local to the receiving process.

Why hub-and-spoke over mesh (direct peer connections): deadlock detection requires a global graph of pending blocking sends. Centralizing in the broker gives a single authority for channel enforcement, deadlock checks, and agent liveness — no distributed coordination needed. Groups are small and LLM latency dwarfs the extra hop.

The RPC channel (`RpcChild` wrapper) remains in use for: spawning children, delivering the initial task prompt, subscribing to event streams for widget updates, and process lifecycle management. The unix socket handles only inter-agent messaging.

## Open Questions — Resolved

All open questions were resolved during implementation planning.

### Per-agent completion notifications

**Resolved:** Steer `<agent_complete>` to the parent each time an agent goes idle or fails. Includes last assistant message as output (idle) or error details (failed). The parent LLM needs these in context to react to individual completions — the widget is visual-only for the human.

### Agent output capture

**Resolved:** Last assistant message text from the child's RPC event stream (`message_end` event where `message.role === "assistant"`). If no assistant message was produced, output is `"(no output)"`.

### Sending to a done/failed agent

**Resolved:** In RPC mode, agents don't exit after completing a task — they go idle and remain available for new messages. Only crashed agents (nonzero exit) are truly dead. Sends to a failed agent return an error immediately (both fire-and-forget and blocking). Sends to an idle agent work naturally — the broker delivers the message, the child extension calls `pi.sendMessage({ triggerTurn: true })`, and the agent starts a new turn.

**v2 idea:** Agent resurrection — restart crashed agents with session continuity so they can receive pending messages. Parked because RPC mode's long-lived processes already solve the common case (idle agents receiving follow-up messages). Resurrection only matters for crash recovery.

### Group cancellation

**Resolved:** `teardown_group` tool. The parent calls it to explicitly end the group — kills all processes, steers `<group_complete>`, clears widget. Serves both the "we're done" and "cancel early" use cases. No auto-completion — the parent always decides when the group ends, informed by `<group_idle>` notifications.

### `check_status` group-level query

**Resolved:** `agent` parameter is optional (`Type.Optional`). When omitted, returns summary of all agents. When provided, returns detailed status for that specific agent.

### Agent state transitions

**Resolved:** States are `running`, `idle`, `waiting`, `failed`. Failed is terminal (process crash). All others are fluid — agents cycle between running/idle/waiting as they process tasks, send messages, and receive responses. Transitions: running→idle (agent_end), running→failed (crash), idle→running (new message), running→waiting (blocking send), waiting→running (response or error).

### `subagent` tool acknowledgment format

**Resolved:** Structured text listing agent IDs, tasks, and validated topology:
```
Group spawned: 3 agents
- scout: task="Find auth providers", channels=[planner, parent]
- planner: task="Create plan", channels=[scout, worker, parent]
- worker: task="Implement changes", channels=[planner, parent]
Use check_status to monitor progress. Send messages to any agent via send.
```

### System prompt append file contents

**Resolved:** XML `<subagent_identity>` block passed inline via `--append-system-prompt <text>` (no temp files). Contains: agent id, task, peer list with descriptions from agent definition frontmatter (or "default agent" marker), parent explanation, and protocol section explaining how to recognize and respond to incoming `<agent_message>` XML.

### Minor

- **Temp file lifecycle**: No temp files needed. System prompt identity is passed inline via `--append-system-prompt`.
- **`agentScope` discovery paths**: Same as example extension — user = `~/.pi/agent/agents/`, project = `.pi/agents/` (nearest ancestor).
- **`promptGuidelines` wording**: Concrete text per tool, drafted during implementation (step 10).

## Steps

### Step 1: Package scaffolding

Create `extensions/subagents/` with `package.json` and a no-op `index.ts`.

`package.json`:
```json
{
  "name": "subagents",
  "version": "1.0.0",
  "description": "Group-based subagent orchestration with channel-based inter-agent communication",
  "pi": { "extensions": ["./index.ts"] }
}
```

`index.ts`: no-op default export (`export default function (pi: ExtensionAPI) {}`).

**Verify:** `pi -e extensions/subagents/index.ts --mode json -p "hello" 2>&1 | head -5` starts without extension load errors.
**Status:** not started

### Step 2: `messages.ts` — Structured message format

Create `extensions/subagents/messages.ts`. No dependencies on other extension modules.

**LLM-facing XML formats** — serialization functions (string builders) and types:

- `AgentMessageData { from, content, correlationId?, responseExpected }` → `serializeAgentMessage()` producing the `<agent_message>` XML.
- `AgentCompleteData { id, status: "idle" | "failed", output?, error? }` → `serializeAgentComplete()` producing `<agent_complete>`.
- `GroupIdleData { agents: AgentCompleteData[], usage: { input, output, cost } }` → `serializeGroupIdle()` producing `<group_idle>` with inline per-agent status, usage, and the "call teardown_group when done" note.
- `GroupCompleteData { agents: AgentCompleteData[], usage: { input, output, cost } }` → `serializeGroupComplete()` producing `<group_complete>`.
- `SubagentIdentityData { id, task, peers: Array<{ id, description?, isDefault }> }` → `serializeSubagentIdentity()` producing `<subagent_identity>`.

**Broker wire protocol** — JSONL types for unix socket communication (not XML, internal only):

```typescript
type BrokerRequest =
  | { type: "register"; agentId: string }
  | { type: "send"; from: string; to: string; message: string; correlationId?: string; expectResponse?: boolean }
  | { type: "respond"; from: string; correlationId: string; message: string };

type BrokerResponse =
  | { type: "registered" }
  | { type: "message"; from: string; message: string; correlationId?: string; responseExpected?: boolean }
  | { type: "response"; correlationId: string; message: string }
  | { type: "send_ack" }
  | { type: "error"; correlationId?: string; error: string };
```

Export all types and functions.

**Verify:** File exists, exports typed serialization functions. Read the code and confirm XML output matches the formats in the Architecture section.
**Status:** not started

### Step 3: `channels.ts` — Topology validation

Create `extensions/subagents/channels.ts`. No dependencies on other extension modules.

```typescript
type Topology = Map<string, Set<string>>;  // agentId → set of allowed targets
```

- `buildTopology(agents: Array<{ id: string; channels?: string[] }>): Topology` — For each agent, creates allowed target set: declared peer channels + `"parent"`. Adds a `"parent"` entry that can send to all agents.
- `validateTopology(agents: Array<{ id: string; channels?: string[] }>): string | null` — Returns error message if any channel reference doesn't resolve to an agent id in the group. Null if valid. Disconnected agents (empty channels) allowed.
- `canSend(topology: Topology, from: string, to: string): boolean` — Runtime check used by broker.

**Verify:** Read the code. Trace: agent with `channels=["peer1"]` → allowed targets `{"peer1", "parent"}`. Parent → can send to any agent. Invalid reference → error string.
**Status:** not started

### Step 4: `deadlock.ts` — Cycle detection graph

Create `extensions/subagents/deadlock.ts`. No dependencies on other extension modules.

```typescript
class DeadlockGraph {
  addEdge(from: string, to: string): void;
  removeEdge(from: string, to: string): void;
  removeAllEdgesTo(target: string): void;
  wouldCauseCycle(from: string, to: string): boolean;  // DFS from `to` looking for `from`
}
```

`wouldCauseCycle` does NOT add the edge — caller adds after validation. `removeAllEdgesTo` used when agent dies (broker cleanup).

**Verify:** Trace: edges A→B, B→C. `wouldCauseCycle("C", "A")` → true (would create A→B→C→A). `wouldCauseCycle("C", "D")` → false.
**Status:** not started

### Step 5: `rpc-child.ts` — RPC protocol wrapper

Create `extensions/subagents/rpc-child.ts`. No dependencies on other extension modules. Uses `node:child_process` and `node:string_decoder`.

```typescript
interface RpcChildOptions {
  cwd?: string;
  env?: Record<string, string>;
  args?: string[];
}

class RpcChild {
  start(): Promise<void>;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  stop(): Promise<void>;           // SIGTERM → 5s → SIGKILL
  onEvent(listener: (event: any) => void): () => void;
  get exitCode(): number | null;
  get pid(): number | undefined;
  get stderr(): string;
}
```

**JSONL framing:** Write `JSON.stringify({ id, type, ... }) + "\n"` to stdin. Read stdout by buffering chunks, splitting on `"\n"`, parsing each line. Lines with `type: "response"` matched to pending requests by `id`. All others dispatched to event listeners.

**Verify:** File exists, class exported. Full integration deferred to step 11.
**Status:** not started

### Step 6: `agents.ts` — Agent discovery with skills

Create `extensions/subagents/agents.ts`. Fork from `examples/extensions/subagent/agents.ts`.

Changes from the example:

1. Add `skills?: string[]` to `AgentConfig`. Parse from frontmatter same as `tools` (comma-separated).

2. Add `resolveSkillPaths(skillNames: string[], commands: Array<{ name: string; source: string; path?: string }>): string[]` — filters commands to `source === "skill"`, matches by name, returns paths. Throws if a skill name doesn't resolve.

3. Add `buildAgentArgs(agent: AgentConfig, skillPaths: string[]): string[]` — builds CLI args: `--no-session`, `--model` if set, `--tools` if set, `--no-skills --skill <path>...` if skillPaths non-empty.

Keep existing `discoverAgents`, `AgentScope`, `AgentDiscoveryResult`, `formatAgentList` unchanged.

**Verify:** File exists. `AgentConfig` has `skills` field. `resolveSkillPaths` and `buildAgentArgs` exported.
**Status:** not started

### Step 7: `broker.ts` — Unix socket message broker

Create `extensions/subagents/broker.ts`. Depends on `channels.ts`, `deadlock.ts`, `messages.ts`. Uses `node:net`, `node:os`, `node:crypto`.

```typescript
interface BrokerOptions {
  topology: Topology;
  onParentMessage: (msg: BrokerResponse) => void;
}

class Broker {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  agentDied(agentId: string): void;
  isQuiet(): boolean;
  getConnectedAgentIds(): string[];
}
```

**Socket path:** `path.join(os.tmpdir(), 'pi-broker-' + crypto.randomUUID() + '.sock')`.

**Connection lifecycle:** Child connects, sends `{ type: "register", agentId }`. Broker maps `agentId → socket`. On socket close → `agentDied()` internally.

**`send` routing:**
1. `canSend(topology, from, to)` — reject if not allowed.
2. Target is dead (failed agent) → immediate error.
3. Target is `"parent"` → deliver via `onParentMessage` callback.
4. `expectResponse` → `wouldCauseCycle(from, to)` check → reject if cycle. Add edge. Hold pending correlation `{ correlationId, senderSocket, from }`.
5. Forward `{ type: "message", ... }` to target's socket.
6. Fire-and-forget → `send_ack` back to sender.

**`respond` routing:** Look up pending correlation. Found → remove deadlock edge, send `{ type: "response" }` to original sender, `send_ack` to responder. Not found → error.

**`agentDied(agentId)`:** Synthetic error responses to all blocked senders waiting on this agent. Remove deadlock edges. Close socket.

**JSONL framing** on unix socket: newline-delimited JSON, per-connection line buffer.

**`isQuiet()`:** Returns true when no pending correlations exist and no messages are buffered. Used by group.ts to detect group-idle state.

**Verify:** File exists, `Broker` class exported. Types align with imports from channels.ts, deadlock.ts, messages.ts.
**Status:** not started

### Step 8: `group.ts` — Group lifecycle management

Create `extensions/subagents/group.ts`. Depends on `rpc-child.ts`, `broker.ts`, `agents.ts`, `messages.ts`, `channels.ts`.

```typescript
type AgentState = "running" | "idle" | "waiting" | "failed";

interface AgentStatus {
  id: string;
  state: AgentState;
  agentDef?: string;
  task: string;
  channels: string[];
  lastActivity?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
  model?: string;
  lastOutput?: string;
  pendingCorrelations: string[];
}

interface GroupManagerOptions {
  pi: ExtensionAPI;
  agents: Array<{ id: string; agent?: string; task: string; channels?: string[] }>;
  agentConfigs: AgentConfig[];
  topology: Topology;
  skillPaths: Map<string, string[]>;
  cwd: string;
  onUpdate: () => void;
  onGroupIdle: () => void;
  onAgentComplete: (agentId: string) => void;
}

class GroupManager {
  getAgentStatuses(): AgentStatus[];
  getCompletionReport(): GroupCompleteData;
  start(): Promise<string>;      // spawn children, start broker, return acknowledgment
  destroy(): Promise<void>;      // kill all processes, stop broker
}
```

**`start()` flow:**
1. Create and start `Broker` with topology and parent message handler.
2. For each agent: build `<subagent_identity>` XML via `serializeSubagentIdentity()` (with peer descriptions from `agentConfigs`). Build CLI args via `buildAgentArgs()`. Add `--append-system-prompt <identityXml>` (inline text, no temp file). Spawn `RpcChild` with `PI_SUBAGENT` env var (JSON: `{ id, channels, task, brokerSocket }`).
3. Start all RpcChild processes.
4. Subscribe to each child's events via `onEvent()`: update `AgentStatus` on `tool_execution_start` (lastActivity), `message_end` with `role === "assistant"` (lastOutput, usage, turns, model), `agent_end` (state → idle, call `onAgentComplete`), `agent_start` (state → running).
5. Send initial task via `rpcChild.prompt("Task: " + task)` for each.
6. On RpcChild process exit with nonzero code → state = failed, call `broker.agentDied(id)`, call `onAgentComplete`. Call `onUpdate`.
7. After each state change: check if all agents are idle/failed AND `broker.isQuiet()` → call `onGroupIdle`.
8. Return acknowledgment text (agent list with IDs, tasks, channels).

**`destroy()`:** Stop all RpcChild processes, stop broker.

**Verify:** File exists, `GroupManager` class exported. Types align with all dependencies.
**Status:** not started

### Step 9: `widget.ts` — TUI widget rendering

Create `extensions/subagents/widget.ts`. Depends on types from `group.ts`.

```typescript
function renderGroupWidget(statuses: AgentStatus[], theme: Theme): string[];
```

**Layout** — one line per agent + aggregate:
```
⏳ scout    read src/auth/  ↑2.1k ↓0.5k $0.02
⏸ planner  waiting for scout  ↑1.0k ↓0.3k $0.01
✓ worker   idle  ↑5.0k ↓2.0k $0.08
─── 3 agents: 1 idle, 1 running, 1 waiting │ ↑8.1k ↓2.8k $0.11
```

Status icons: `⏳` running, `✓` idle, `✗` failed, `⏸` waiting. Activity column: formatted last tool call for running (same `formatToolCall` pattern as example extension), "waiting for response from X" for waiting, "idle"/"failed" for terminal-ish states. Usage: compact `↑input ↓output $cost`. Aggregate line: counts by state + total usage. Style with `theme.fg(...)`.

**Verify:** File exists, function exported. Output format matches layout spec.
**Status:** not started

### Step 10: `index.ts` — Entry point, tools, and protocol content

Replace the no-op `index.ts` with the full entry point. This is the largest step.

**Role detection:** `process.env.PI_SUBAGENT` — absent = root, present = parse JSON payload `{ id, channels, task, brokerSocket }` = child.

**Both roles register all five tools:** `subagent`, `send`, `respond`, `check_status`, `teardown_group`.

**`subagent` tool:**
- Parameters: as in architecture Interfaces section.
- `promptGuidelines`: concise text covering group spawn semantics, non-blocking return, one active group at a time.
- `execute`: Discover agents, validate topology, resolve skill paths, create and start `GroupManager`. Set `onUpdate` to re-render widget via `renderGroupWidget()` → `ctx.ui.setWidget("subagents", lines)`. Set `onAgentComplete` to steer `<agent_complete>` via `pi.sendMessage()`. Set `onGroupIdle` to steer `<group_idle>` (with inline statuses) via `pi.sendMessage()`. Return acknowledgment text.
- Reject if a group is already active.

**`teardown_group` tool:**
- Parameters: empty `Type.Object({})`.
- `promptGuidelines`: "Call teardown_group to end the current agent group. Kills all agent processes and delivers a final summary."
- `execute`: Build `GroupCompleteData` from `getCompletionReport()` → `serializeGroupComplete()` → steer to parent via `pi.sendMessage()`. Call `destroy()`. Clear widget. Clear active group reference. Return confirmation text.

**`send` tool:**
- Parameters: as in architecture.
- `promptGuidelines`: text covering fire-and-forget vs blocking, scatter-gather via concurrent sends, channel enforcement.
- `execute` (child): write `BrokerRequest` to broker socket, wait for `send_ack`/`response`/`error`. Fire-and-forget returns "Message sent to <to>." Blocking generates a correlationId (UUID), waits for matching `response` or `error`, returns the response text or throws.
- `execute` (root/parent): same path, `from: "parent"`.

**`respond` tool:**
- Parameters: as in architecture.
- `promptGuidelines`: text explaining when to use it (response_expected="true" messages).
- `execute`: write `BrokerRequest` to broker socket, wait for `send_ack`/`error`.

**`check_status` tool:**
- Parameters: `agent` is `Type.Optional(Type.String())`.
- `promptGuidelines`: "Query agent status. Omit agent for group summary."
- `execute`: if no active group → error. If `agent` specified → return that agent's `AgentStatus` formatted as text. If omitted → return all statuses.

**Child role setup** (PI_SUBAGENT present):
- Parse identity from env var.
- Connect to broker unix socket via `node:net` `createConnection(brokerSocket)`.
- Send `{ type: "register", agentId: id }` on connect.
- JSONL line reader on socket for incoming messages.
- On `{ type: "message" }` → `serializeAgentMessage()` → `pi.sendMessage({ customType: "subagents", content: xml, display: true }, { deliverAs: "steer", triggerTurn: true })`.
- The `send`/`respond` execute functions write to this socket and await responses.

**Verify:** `pi -e extensions/subagents/index.ts --mode json -p "what tools do you have" 2>&1` shows all five tools (`subagent`, `send`, `respond`, `check_status`, `teardown_group`). No extension load errors.
**Status:** not started

### Step 11: Integration smoke test

Test the full flow manually:

1. Start pi interactively with the extension loaded.
2. Have the LLM call `subagent` with 2 default agents, one channel between them, simple tasks (e.g., "list .ts files" and "count lines in the files scout finds").
3. Verify: widget appears and updates in real-time. Agents run their tasks. Inter-agent communication works (send/respond between peers). `<agent_complete>` steered to parent per agent. `<group_idle>` steered when all idle with inline status. Parent calls `teardown_group`. `<group_complete>` steered. Widget clears.
4. Test `check_status` both with and without agent param mid-run.
5. Test edge case: send to a crashed/failed agent → immediate error.

Fix any issues found.

**Verify:** A 2-agent group completes with at least one inter-agent message exchange. Full lifecycle: spawn → communicate → idle notification → teardown → completion report.
**Status:** not started
