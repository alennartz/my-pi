# DR-015: Group-Based Spawn Model with Code-Enforced Channel Topology

## Status
Accepted

## Context
The example subagent extension offered three spawn modes (single, parallel, chain) as separate operations. Inter-agent communication was either absent or relied on LLM compliance with prompt instructions. A more general model was needed that could express arbitrary communication patterns while guaranteeing topology constraints deterministically.

## Decision
A single `subagent` tool call declares a group of agents and their full communication topology upfront. Each agent gets a `channels` list of peer IDs it can send to; the parent is auto-injected into every agent's channel list. Topology is validated at spawn time (all channel references must resolve to agent IDs in the group; disconnected agents with no channels are allowed). At runtime, the broker enforces channels — sends to peers not in the sender's list are rejected with an error. One active group at a time; the parent explicitly ends it via `teardown_group`. The three original modes are subsumed: parallel is a group with no inter-agent channels, chain is a sequence of groups (deferred to v2), and arbitrary topologies (star, mesh, hub-and-spoke) are expressed directly.

## Consequences
One primitive covers all multi-agent patterns, reducing API surface and conceptual overhead. Code enforcement means topology violations are caught instantly and deterministically — no LLM judgment involved. The spawn-time validation catches misconfigured topologies before any agent starts running. Tradeoff: the one-group-at-a-time constraint limits concurrent independent work streams (a second `subagent` call while a group is active returns an error). This is acceptable for v1 — sequential groups cover most orchestration patterns, and lifting the constraint is a straightforward extension if needed.
