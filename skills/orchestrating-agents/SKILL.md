---
name: orchestrating-agents
description: "Delegate work to subagents to preserve primary agent context, parallelize independent tasks, or coordinate specialists. Use when the work ahead is context-heavy (many file reads, large implementations, multi-step investigations), naturally parallelizable, benefits from specialist coordination, or the user asks for agent-based execution. Covers task decomposition, orchestration patterns, topology design, communication modes, and specialist coordination."
---

# Orchestrating Agents

## Overview

Subagents let you delegate work to separate agent processes, each with its own context window. The primary benefit is **context efficiency** — a subagent absorbs all the heavy tool use (file reads, edits, test runs, investigations) and returns a compact result. Your context stays clean, letting you handle more total work across a session.

Beyond context management, subagents enable parallel execution, specialist coordination, and rich inter-agent communication. This skill covers the thinking that happens *before* you call `subagent` — task decomposition, pattern selection, topology design. Once the group is running, the tool descriptions, notifications (`<agent_complete>`, `<group_idle>`, `<agent_message>`), and communication tools carry you from there.

## When to Use Subagents

### Context preservation — the primary reason

Every tool call you make (reading files, running commands, editing code) adds to your context. Large tasks — implementing a feature across several files, investigating a complex bug, processing many files — can consume most of your context window, leaving little room for the user's next request. Subagents solve this: delegate the heavy work, get a summary back, and continue with a clean context.

**Think about subagents when:**
- The task involves reading or editing many files
- An implementation will require dozens of tool calls
- You're partway through a session and need to preserve remaining context for future work
- The work is investigative — exploring, diagnosing, gathering information — and the intermediate steps matter less than the conclusion

### Parallelizable independent tasks

Multiple pieces of work that don't depend on each other's intermediate results. File-per-file migrations, independent test suites, parallel investigations. Each agent works in isolation and reports back.

### Specialist coordination

Tasks that benefit from focused roles, tool sets, and inter-agent communication. A reviewer and implementer working together via channels. A research agent gathering context while a coding agent builds. When specialist agent definitions are available, they bring domain-specific system prompts and tool scoping that generic agents lack.

### User request

The user explicitly asks for parallel execution, delegation, or agent-based workflows.

### When not to use subagents

- **Sequential work with heavy shared context.** If step 2 depends on step 1's full reasoning — not just its output — do it yourself. Agents can pass messages, but they can't share conversation history.
- **Simple tasks.** If the work takes fewer than a few tool calls, the overhead of spawning a process, connecting to a broker, and tearing down isn't worth it.
- **Work that needs your conversation history.** Agents start with a task string, not your full context. If the task requires deep understanding of an ongoing conversation, keep it in-process.

## Task Decomposition

Each agent should produce a **coherent, independently verifiable deliverable**. That's the unit of decomposition — not "as small as possible" and not "everything in one agent."

**Writing effective task strings.** For default agents (no agent definition), the task string is the *only* instruction they receive. It must carry both identity and mission:

- **Identity:** "You are a TypeScript migration specialist working on…"
- **Mission:** "Convert all files in `src/legacy/` from CommonJS to ESM. For each file, update imports, change `module.exports` to `export`, verify the file parses, and report what you changed."
- **Scope boundaries:** "Do not modify files outside `src/legacy/`. Do not change any public API signatures."
- **Output expectations:** "When finished, report the list of converted files and any files you skipped with reasons."

**Granularity.** Too coarse wastes parallelism — one agent doing everything is just you with extra overhead. Too fine creates coordination overhead — ten agents that each change one line need more orchestration than the work itself. A good agent-sized task takes multiple tool calls, produces a meaningful result, and can be verified without understanding the other agents' work.

## Orchestration Patterns

### Fan-out / Fan-in

Independent parallel tasks. No peer communication needed. Parent spawns agents, waits for `<group_idle>`, gathers results.

```
agents: [a, b, c]  — no channels
parent ← a, b, c (via <agent_complete>)
```

**When to use:** Embarrassingly parallel work. Each agent's task is self-contained. Examples: migrating independent files, running separate analyses, generating documentation for unrelated modules.

### Pipeline

Linear chain where each stage feeds the next. Each agent has a channel to the next agent in the sequence.

```
agents: [a → b → c]
a.channels: [b]
b.channels: [c]
```

Agent `a` does its work, sends output to `b` via `send`, and finishes. Agent `b` receives via `<agent_message>`, does its work, sends to `c`. The parent gets `<agent_complete>` as each stage finishes.

**When to use:** Sequential transformations where each stage has a distinct role. Examples: generate → review → polish; extract → transform → load.

### Collaborative Team

Independent work with selective peer channels for lateral consultation. The most general and powerful pattern.

```
agents: [frontend, backend, reviewer]
frontend.channels: [reviewer]
backend.channels: [reviewer]
reviewer.channels: [frontend, backend]
```

Each agent works on its own task. Peers can send messages for consultation — fire-and-forget for FYI updates, blocking sends for questions that gate progress. The parent gets completion notifications as usual.

**When to use:** Loosely coupled work where agents occasionally need each other's input. Examples: coordinated feature development across modules, parallel implementation with a shared reviewer.

### Scatter-Gather

Parent queries multiple agents via blocking sends in the same turn, then synthesizes responses. Requires a long-lived group (agents must be idle but not torn down).

```
agents: [expert-a, expert-b, expert-c]  — no peer channels
parent sends: send(to="expert-a", expectResponse=true)
              send(to="expert-b", expectResponse=true)
              send(to="expert-c", expectResponse=true)
(all three in the same turn — they execute concurrently)
```

**When to use:** Gathering perspectives, votes, or analyses from multiple specialists. Examples: getting security, performance, and API-design reviews of the same diff; polling multiple domain experts for a recommendation.

### Persistent Specialists

Long-lived group tapped on demand. Parent sends new work to idle agents as needs arise; the group stays alive across multiple exchanges. Agents don't finish after one task — they idle and wait for more messages.

```
agents: [researcher, coder]  — no peer channels (or selective ones)
parent sends work → agent works → agent reports → agent idles
parent sends more work later → same agent picks up
```

**When to use:** Ongoing sessions where the same specialist capabilities are needed repeatedly. Examples: a research assistant the user queries throughout a session; a pair of agents (coder + reviewer) that handle multiple rounds of work.

### Iterative Refinement

Produce-review-revise loop. Can be parent-driven (parent mediates each round) or peer-driven (producer and reviewer have mutual channels).

**Parent-driven:**
```
agents: [writer, reviewer]  — no peer channels
parent sends work to writer → writer produces → parent sends to reviewer
→ reviewer critiques → parent sends feedback to writer → repeat
```

**Peer-driven:**
```
agents: [writer, reviewer]
writer.channels: [reviewer]
reviewer.channels: [writer]
```

Writer produces and sends to reviewer. Reviewer critiques and sends back. They iterate until satisfied, then report to parent.

**When to use:** Work that benefits from multiple revision passes. Examples: document drafting with editorial review, code generation with correctness checking.

## Communication and Topology Design

### Topology

Start minimal. Only declare peer channels where agents genuinely need lateral communication. Parent is always available — it's auto-injected into every agent's channel list (you never need to declare it).

- **Fan-out** needs no peer channels.
- **Pipeline** needs a linear chain: `a→b→c`.
- **Collaborative team** needs selective connections based on expertise overlap. Don't mesh everything — only connect agents that actually consult each other.
- **More channels = more noise.** An agent that can talk to everyone will be tempted to. Constrain topology to the communication you actually want.

All channel references are validated at spawn time — referencing a non-existent agent id in `channels` is an error.

### Fire-and-Forget (Default)

The default `send` mode. The message is delivered and the sender continues immediately. The target receives it as an `<agent_message>` block with `response_expected="false"`.

Use for: status updates, heads-ups, sharing intermediate findings, handing off work. Any time the sender doesn't need to wait for a reply.

### Blocking Sends

Set `expectResponse=true`. The sender's `send` tool call stays open until the target calls `respond` with the matching `correlationId`. The response is delivered as the tool call's return value.

Use for: questions that gate progress, scatter-gather queries, any synchronous coordination where the sender genuinely cannot continue without a response.

For scatter-gather, call multiple `send(expectResponse=true)` in the same turn. They execute concurrently — each unblocks independently when its target responds.

### Deadlock Awareness

The broker detects cycles in blocking sends via directed-graph DFS and rejects sends that would create a deadlock. The rejected send returns an error immediately.

Avoid designs where agents form blocking rings. If A blocks on B, B must not block on A (or on anyone who transitively blocks on A). Common safe patterns:

- **Unidirectional blocking:** A blocks on B, B never blocks on A. Works for pipeline and scatter-gather.
- **Parent as mediator:** Agents only block on parent. Parent blocks on agents. No peer blocking. Simplest deadlock-free design.
- **Mixed:** Fire-and-forget for peer communication, blocking only toward parent. Keeps the dependency graph acyclic.

## Recursive Subagents

Any agent — including a child agent — can spawn its own sub-group using the same `subagent` tool. The child has the full tool suite (`subagent`, `send`, `respond`, `check_status`, `teardown_group`).

Normally, the primary agent (with the TUI) is the lead — it decomposes work and spawns workers directly. But if a worker's task is large enough to warrant further decomposition, that worker can spawn its own sub-group. The primary sees only the worker; the worker's sub-group is invisible above it. This enables hierarchical decomposition without the primary managing every leaf agent.

## Key Principles

- **Design before spawning** — think through decomposition, pattern, and topology before calling `subagent`. Restructuring a running group means tearing down and respawning.
- **Task strings are the whole brief** — for default agents, the task string is all they get. Make it complete: identity, mission, scope, output expectations.
- **Minimal topology** — only connect agents that need to talk. Parent is always there; peer channels are for lateral communication only.
- **Default to fire-and-forget** — use blocking sends only when the sender genuinely can't continue without a response.
- **One group at a time** — the `subagent` tool enforces this. Tear down before spawning a new group.
- **Let notifications drive you** — `<agent_complete>` and `<group_idle>` arrive automatically. Don't poll with `check_status` unless you have a specific reason.

For creating persistent, reusable agent definitions (the `.md` files referenced by the `agent` field), see the **specialist-design** skill.
