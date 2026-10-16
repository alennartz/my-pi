# DR-058: Serialize lifecycle tools to preserve steer delivery

## Status
Accepted

## Context
A parent can emit several tool calls in one assistant message. Pi runs those calls in parallel unless a tool declares sequential execution. That exposed two startup races: a parent could send to a child before `subagent` or `resurrect` committed the child, and a resumed child could receive its initial task while another startup turn was already running.

A target-keyed readiness gate would preserve parallel lifecycle calls. It would also require pre-execution spawn intent registration, one readiness promise per target, failure and teardown cleanup, and routing changes for pending children. The current subagent manager only routes to committed children.

## Decision
The `subagent`, `fork`, and `resurrect` tools use `executionMode: "sequential"`. Pi therefore runs the complete assistant tool batch sequentially when any of these tools appears. A lifecycle call listed before `send` completes child construction before `send` runs.

`send` remains parallel-capable and keeps its existing steer behavior. Child initial task submissions use `followUp` so a startup continuation cannot reject them as already processing. An idle child starts the task normally; a busy child queues it after the current turn.

We reject a target-keyed readiness gate for now. The extra synchronization layer does not justify its complexity until parallel lifecycle fan-out or order-independent `send` becomes a real requirement.

## Consequences
The common spawn-then-send sequence is reliable, and send delivery semantics do not change. Lifecycle calls lose parallelism within any tool batch that contains `subagent`, `fork`, or `resurrect`. This is an intentional throughput trade-off.

The ordering remains model-dependent: `send` listed before the lifecycle call can still fail, and unrelated lifecycle calls cannot fan out in parallel. Revisit this decision if either case appears in real use. The future design is a target-keyed readiness gate that reserves spawn intent before parallel tool execution, waits only sends targeting that agent, and cleans up pending reservations on failure or teardown.
