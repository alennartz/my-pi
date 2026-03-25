# DR-021: Dynamic Membership Over Multiple Concurrent Groups

## Status
Accepted

## Context
The subagents extension needed to support spawning new agents while others were already running — a concrete blocker for workflows where an orchestrating agent wants to fork itself or add specialists to a running set of workers. Two approaches solve this: multiple concurrent independent groups, or making the single group's membership dynamic.

## Decision
Dynamic membership. `subagent` and `fork` add agents to the existing set instead of erroring when agents are already running. `teardown` (renamed from `teardown_group`) can remove individual agents or tear down everything. The single-group mental model is preserved.

Multiple concurrent groups was rejected because it would require group IDs threaded through every tool call (`send`, `respond`, `check_status`, `teardown`), notification multiplexing so the LLM could tell which group a notification came from, multi-widget rendering, and disambiguation logic throughout. The LLM's existing understanding of the tools — one namespace, direct agent IDs — would break.

## Consequences
Same tools, extended behavior — `subagent` creates infrastructure on first call and adds agents on subsequent calls, `teardown` gains an optional `agent` parameter for selective removal. No new API surface for the LLM to learn. Tradeoff: truly independent workstreams share one topology and one broker, so a full teardown kills everything. Acceptable because the orchestrating agent knows its own work and can sequence accordingly. If the constraint ever binds, concurrent groups could still be layered on top.
