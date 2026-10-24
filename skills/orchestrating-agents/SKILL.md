---
name: orchestrating-agents
description: "Plan and coordinate subagent work when a task is context-heavy, parallelizable, specialist-driven, or explicitly delegated. Covers delegation decisions, task briefs, topology, communication, and child-session lifecycle."
---

# Orchestrating Agents

Delegate to preserve context, parallelize independent work, or use specialist focus. A child absorbs heavy tool work and returns a compact result. Child sessions persist with the parent session. `teardown` has semantic effect, so treat children as managed sessions rather than disposable processes.

## 1. Decide whether to delegate

Delegate when the work:

- involves many files, a large implementation, or a complex investigation;
- contains independent tasks that can run in parallel;
- benefits from a focused specialist or a separate tool scope; or
- is explicitly delegated by the user.

Work directly when the work is small, sequential with heavy shared context, or needs the parent conversation in full.

**Complete when:** the choice has a concrete reason.

## 2. Frame each task

Give each agent one coherent, independently verifiable deliverable. For a default agent, the task string is its full brief. Include:

- **Identity** — the role or expertise required.
- **Mission** — the work to perform.
- **Scope** — files, artifacts, and boundaries.
- **Output** — the result format and completion evidence.

Point at an existing plan, specification, or review instead of copying it into the task string. Choose a unit large enough to require multiple tool calls and small enough to verify without another agent's full reasoning. Do not give one agent unrelated deliverables.

**Complete when:** every task brief names its identity, mission, scope, and output.

## 3. Select the smallest topology

Match the dependency shape to one pattern:

| Work shape | Pattern |
| --- | --- |
| Independent tasks | Fan-out / fan-in |
| Ordered handoff | Pipeline |
| Lateral consultation | Collaborative team |
| Simultaneous opinions from idle agents | Scatter-gather |
| Repeated requests to the same specialists | Persistent specialists |
| Produce, review, revise | Iterative refinement |
| Opposing positions | Adversarial debate |

After selecting a shape, read only that shape's section in [PATTERNS.md](PATTERNS.md) before spawning.

**Complete when:** one pattern explains every dependency between the agents.

## 4. Design the group

Start with the smallest topology. The parent is always available, so declare peer channels only for real lateral communication.

Leave `agents[].model` unset unless a deliberate model choice helps. Read [MODEL-SELECTION.md](MODEL-SELECTION.md) before choosing an explicit model or persona. Read [ADVANCED.md](ADVANCED.md) before setting `cwd`, retaining agents across turns, tearing down or resurrecting them, or letting a child spawn descendants.

**Complete when:** the pattern, channels, model choices, cwd choices, and lifecycle plan are explicit.

## 5. Coordinate without cycles

Fire-and-forget messaging is the default. Use a blocking send only when the sender cannot continue without the reply. Keep blocking dependencies acyclic. An agent completes by returning its final response and going idle; do not send a duplicate completion report.

Before adding peer channels, using a blocking send, waiting for completion, or interpreting idle notifications, read [COORDINATION.md](COORDINATION.md).

**Complete when:** every result is collected without a blocking cycle and the parent can synthesize the deliverables.

For reusable agent definitions, read [specialist-design](../specialist-design/SKILL.md).