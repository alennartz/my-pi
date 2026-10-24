# Orchestration Patterns

Read the section that matches the selected work shape. Each section defines the topology, communication direction, and completion boundary. Use [COORDINATION.md](COORDINATION.md) for send semantics and blocking rules.

## Fan-out / Fan-in

**Use when:** tasks are independent and the parent can combine their results.

**Topology:** spawn one agent per task. Use no peer channels.

**Completion:** the parent receives one result from every task, then performs the synthesis.

## Pipeline

**Use when:** each stage depends on the result of the preceding stage.

**Topology:** connect stages in one direction, such as `a → b → c`. Give each stage a channel to the next stage only.

**Completion:** each stage hands off its result before the next stage starts its dependent work. The final stage returns the pipeline result.

## Collaborative Team

**Use when:** independent work benefits from selective lateral consultation.

**Topology:** give each specialist only the peer channels it needs. Keep the parent as the lead and synthesizer.

**Completion:** each specialist returns its own deliverable. The parent resolves overlap and combines the results.

## Scatter-Gather

**Use when:** several idle specialists can answer the same question and the parent needs their perspectives together.

**Topology:** send blocking requests from the parent to the specialists in one turn. Do not create peer channels unless the specialists must discuss with one another.

**Completion:** the parent receives every response and compares the perspectives.

## Persistent Specialists

**Use when:** the same specialists will receive work repeatedly during the session.

**Topology:** keep an active set of named agents. Send new work to idle agents instead of spawning replacements.

**Completion:** an agent reports its result and returns to idle. Retain the set until the repeated work ends. Read [ADVANCED.md](ADVANCED.md) before teardown or resurrection.

## Iterative Refinement

**Use when:** a producer's result improves through review and revision.

**Topology:** use a parent-driven loop when the parent should mediate each round. Use mutual producer and reviewer channels when the agents can exchange drafts directly.

**Completion:** stop after the reviewer accepts the result or the parent resolves the remaining findings. Return the accepted artifact, not an intermediate draft.

## Adversarial Debate

**Use when:** a decision benefits from opposing positions that must engage with each other.

**Topology:** assign each agent a position and give the positions peer channels. A full mesh fits two or three positions. Use a smaller topology for more positions.

**Completion:** each agent states its final position and either concedes or records the unresolved impasse. The parent makes the decision.
