# Plan: Remove agentScope and confirmProjectAgents from subagent tool

## Context

Remove two LLM-facing tool parameters (`agentScope`, `confirmProjectAgents`) that shouldn't be model-controlled. Hardcode their behavior instead: always discover agents from both scopes, always confirm project-local agents. See [brainstorm](../brainstorms/subagent-tool-params.md).

## Architecture

### Impacted Modules

**Subagents Extension** — The only module affected. Changes are confined to the tool schema, execute function, and agent discovery interface:

- `agents.ts`: Remove the `AgentScope` type. Remove the `scope` parameter from `discoverAgents` — it always discovers from both user and project directories. The function signature becomes `discoverAgents(cwd: string)`. The internal branching on scope collapses to the current `"both"` path.

- `index.ts`: Remove `AgentScopeSchema` definition. Remove `agentScope` and `confirmProjectAgents` from the `subagent` tool's parameter schema. In `execute`, replace `params.agentScope ?? "user"` with the now-scopeless `discoverAgents(ctx.cwd)`. Remove the `params.confirmProjectAgents ?? true` conditional — always confirm when project agents are present and `ctx.hasUI` is true. The `before_agent_start` hook already calls `discoverAgents(process.cwd(), "both")` — update it to the new signature (no scope arg).
