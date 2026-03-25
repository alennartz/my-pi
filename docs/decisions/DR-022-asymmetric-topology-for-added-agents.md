# DR-022: Asymmetric Topology for Incrementally Added Agents

## Status
Accepted

## Context
With dynamic group membership (DR-021), agents added after the initial spawn need communication channels. Three options: symmetric (new agents and existing agents mutually gain channels), asymmetric (new agents can target existing agents but existing agents' channel sets are unchanged), or isolated (new agents start disconnected).

## Decision
Asymmetric topology. New regular agents declare channels at add time, which can reference existing agent IDs. Existing agents' channel sets are not modified. Fork agents get parent-equivalent access — channels to all existing agents — since they're clones of the orchestrator and inherit its knowledge of the group.

Symmetric was rejected because it mutates running agents' communication capabilities without their knowledge — an agent mid-task could suddenly have new peers it wasn't designed to interact with, complicating both agent behavior and debugging. Isolated was rejected because the primary use case for incremental adds is agents that need to communicate with the existing set (e.g., a fork that coordinates with running workers).

## Consequences
Existing agents' behavior is stable — no surprise new communication targets mid-run. The parent acts as a natural relay when an existing agent needs to reach a late-added one, which is low-cost since the parent is already the orchestration hub. Tradeoff: patterns where a worker needs to spontaneously reach a late-added specialist require explicit relay through the parent rather than direct messaging.
