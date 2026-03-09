# Subagents — Brainstorm

## The Idea

Build a subagents feature as a superset of the example subagent extension from pi-mono. Delegates tasks to specialized agents running in isolated `pi --mode rpc` processes. Goes beyond the example by adding: default agent mode (stock pi, no custom agent definition), skill filtering for agents, and inter-agent communication with channel-based topology.

## Key Decisions

### Group-Based Spawn Model (replaces single/parallel/chain)

The example extension had three modes: single agent, parallel agents, chain of agents. These are all subsumed by a single group model — one `subagent` tool call declares a set of agents and their communication topology. The tool is **non-blocking** because the parent agent must remain available to receive messages from children.

**Why non-blocking:** The parent is just another peer in the communication topology. If the `subagent` tool blocked, the parent couldn't process incoming messages from children (clarification requests, escalations, progress updates). The parent LLM needs to be free to respond.

**Why group-based:** Parallel mode is just a group with no channels. Chain is a sequence of groups (deferred to v2). The group model is the primitive that covers all cases.

### RPC Mode for Subagent Processes

Subagents spawn as `pi --mode rpc` processes (not `--mode json` as in the example). RPC mode gives bidirectional communication over stdin/stdout — the parent can inject messages mid-stream via `steer` and `follow_up` commands. This is what makes inter-agent communication trivial: the parent extension writes a `steer` command to a child's stdin, and the child sees it as an injected message in its conversation.

### Channel-Based Communication Topology

The parent declares the full topology at spawn time:
- Each agent gets a list of peers it can communicate with
- Channels are validated in extension code (not LLM honor system) — the `send` tool rejects messages to peers not in the caller's channel list
- The parent inserts itself into the channel list of any agent it wants to communicate with — it is not special, just another peer

**Why code-enforced:** Deterministic, no LLM judgment involved. The topology is a hard constraint.

### Communication Tools: `send` and `respond`

Two tools for inter-agent messaging:

**`send(to, message, expectResponse?)`**
- Fire-and-forget (default): delivers message, returns immediately
- Blocking (`expectResponse: true`): holds the tool execution open until the receiver calls `respond`, then returns the response as the tool result
- Single target only — no array form. Broadcast/multicast/scatter-gather is achieved by the LLM issuing multiple `send` calls in one turn (pi executes tool calls in parallel)

**`respond(correlationId, message)`**
- Replies to an incoming message that expects a response
- The correlation ID comes from the structured message format injected into the receiver's conversation
- Only valid when there's a pending request matching the correlation ID

**Why no array form on `send`:** The LLM's ability to invoke multiple tool calls concurrently makes explicit broadcast/multicast syntax unnecessary. Scatter-gather falls out naturally — multiple blocking `send` calls in one turn all resolve in parallel. The prompt guidelines explain how to achieve these patterns.

**Why a separate `respond` tool (not reusing `send`):** `respond` is semantically different — it's a reply to a specific message, correlated by ID. Using `send` for replies would lose the correlation and make routing ambiguous.

### Structured Message Format

Inter-agent messages are injected as user messages (via RPC `steer`) with a structured format that agents can recognize unambiguously. The format includes: sender identity, correlation ID (if response expected), and the message content. This same format is used for all agents — parent, children, default agents, specialized agents.

**Why unambiguous structure matters:** Agents need to distinguish "message from another agent" from "message from the user" and respond deterministically via tool call rather than free-form text.

### Parent Is Not Special

The parent agent is just another peer in the topology. It receives inter-agent messages in the same structured format as any other agent. It responds via the same `respond` tool. The only thing that makes it different is that it has the TUI and a human user — so it can exercise judgment about whether to involve the user before responding.

**Why:** Keeps the communication model uniform. No special cases in the protocol. Recursive subagents (a child spawning its own children) work naturally because every agent uses the same tools.

### Default Agent Mode

The `agent` parameter in the `subagent` tool is optional. When omitted, the child process spawns stock pi with no custom system prompt, no tool filtering, no model override. Useful for delegating to a clean context without defining a custom agent.

The communication tools (`send`, `respond`) are still injected via the extension (which auto-discovers in the child process), along with a system prompt append explaining the agent's role in the multi-agent system and its available channels.

### Skill Filtering

Agent `.md` frontmatter gets a `skills` field alongside the existing `tools` field:

```yaml
---
name: planner
description: Creates implementation plans
tools: read, grep, find, ls
skills: architecting, planning
model: claude-sonnet-4-5
---
```

The extension spawns the child with `--no-skills --skill <path>` for each listed skill. Implemented using existing pi CLI flags.

### Deadlock Detection

The extension maintains a graph of pending blocking `send` calls across all agents (including across recursive levels). Before routing a blocking `send`, it checks for cycles. If delivering the message would create a cycle, the `send` is rejected immediately with an error result explaining the deadlock.

**Why in code:** Deterministic, instant, no LLM involvement.

### Synthetic Error Responses

If a subagent process ends (exits, crashes, finishes without calling `respond`) while there are pending correlation IDs awaiting its response, the extension generates synthetic error responses back to all blocked senders. One rule covers all cases: agent dies, agent ignores the message, agent finishes normally without responding.

### Recursive Subagents

Allowed naturally. Since the extension auto-discovers in every `pi` process, any subagent can spawn its own sub-subagents using the same `subagent` tool. The deadlock detection graph spans all levels. TUI visibility for nested groups is deferred to v2 — they appear as opaque tool calls in the parent agent's activity.

### TUI: Widget-Based Group Dashboard

The live state of a running group is displayed as a **widget** (via `ctx.ui.setWidget`), not as a tool result (since `subagent` is non-blocking and returns immediately). The widget shows:
- Per-agent status (running/waiting/done/failed)
- Tool call activity per agent (same style as the example: formatted tool calls, last N items)
- Topology info (channel wiring)
- Inter-agent communication state (e.g., "waiting for response from X")
- Usage stats (tokens, cost) per agent and aggregate
- Expanded/collapsed views (Ctrl+O)

The widget updates in real-time from RPC event streams and clears when the group completes. Final results are delivered as steered messages into the parent's conversation.

### Extension Role Detection

The same extension runs at every level. It detects its role via `ctx.hasUI`:
- **TUI root (`ctx.hasUI === true`)**: registers `subagent` tool with rendering, manages widgets, handles user confirmation for project-local agents
- **Headless child (`ctx.hasUI === false`)**: registers communication tools (`send`, `respond`), connects to parent via RPC stdin/stdout, appends system prompt explaining multi-agent context and available channels

All levels register: `subagent` (for recursive spawning), `send`, `respond`, `check_status`, deadlock detection, channel enforcement.

### Status Polling

A `check_status` tool lets the parent proactively query the state of a spawned group or specific agent. Complements the automatic notifications (per-agent completion, group completion) steered into the parent's conversation.

## Direction

Build a group-based subagent extension with channel-based inter-agent communication over pi's RPC mode. The extension handles topology enforcement, deadlock detection, and message routing in code. The TUI shows live group state via widgets. Recursive subagents are allowed but v2 for nested TUI visibility.

## Open Questions

- Exact structured message format for inter-agent messages (needs to be designed during architecture)
- Prompt guidelines wording for scatter-gather, broadcast, fire-and-forget patterns
- `check_status` tool parameters — group-level vs. agent-level granularity
- How group completion summaries should be formatted when steered into the parent's conversation
- Whether the `subagent` tool should validate the topology at spawn time (e.g., reject disconnected agents with no channels)

## Deferred to v2

- **Chain-of-groups**: sequential execution where each element is a full agent group, output feeds forward. Needs the group primitives to be solid first.
- **Recursive subagent TUI drill-down**: nested groups currently appear as opaque tool calls. Full visibility requires a tree-structured widget or similar.
