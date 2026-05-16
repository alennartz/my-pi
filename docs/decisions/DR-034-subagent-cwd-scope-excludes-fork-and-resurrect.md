# DR-034: Subagent CWD scope excludes fork and resurrect

## Status
Accepted

## Context

Pi's subagent extension exposes three tools that create or revive a child agent: `subagent` (spawn a fresh agent), `fork` (clone the current agent's history into a child), and `resurrect` (revive a previously torn-down agent from its persisted session). When adding a per-agent `cwd` override to support hub-style orchestration across multiple project directories, the question was whether all three should accept `cwd`, or only `subagent`.

Reinforces DR-027 (session replacement for worktree transitions): cwd is captured at session creation, and operating in a different directory requires a fresh session there.

## Decision

Only the `subagent` tool accepts a per-agent `cwd`. `fork` and `resurrect` do not — their TypeBox schemas simply omit the field, and unknown properties are rejected by validation.

Rejected: extending `fork` with `cwd`. A fork carries the parent's full conversation history. Spawning that history into a different repo gives the child a memory of project A while it physically operates in project B — semantically muddled with no concrete use case to justify the confusion.

Rejected: extending `resurrect` with `cwd`. A resurrected agent restores from a recorded session whose original cwd is part of its identity. Allowing a different cwd at resurrection means an agent's working directory mutates across lifetimes — equally muddled, and inconsistent with the principle that a resurrected agent is the *same* agent, not a new one in a borrowed shell.

## Consequences

- The "fan out one agent per project from a hub" workflow works on `subagent` only. Anyone wanting fork-like context in a different repo must instead spawn a fresh `subagent` and re-establish the context they need — which is the right thing to do, since cross-repo context transfer should be explicit.
- A resurrected agent always lands back in the cwd recorded at its original spawn. If that directory is gone, restore-time validation drops the agent rather than silently relocating it.
- If a real use case ever surfaces for fork-with-cwd or resurrect-with-cwd, this decision can be revisited. Until then, narrow scope keeps the semantics clean and avoids decisions about how to reconcile history with a foreign cwd.
- No supersessions. Reinforces DR-027 by giving `subagent` a clean expression of "fresh session = potentially fresh cwd" without breaking the principle for fork/resurrect.
