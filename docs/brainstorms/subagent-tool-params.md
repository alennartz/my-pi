# Brainstorm: Remove agentScope and confirmProjectAgents from subagent tool

## The idea

Remove two tool parameters from the `subagent` tool that shouldn't be LLM-controlled: `agentScope` and `confirmProjectAgents`.

## Key decisions

- **Hardcode `agentScope` to `"both"`** — The LLM has no useful basis for choosing a scope. Agent definitions from both user and project directories should always be discoverable. This also eliminates an existing inconsistency where `before_agent_start` injects agents from both scopes into the system prompt, but the tool defaults to `"user"` only — meaning the LLM could see a project agent in its prompt and then fail to spawn it.

- **Remove `confirmProjectAgents` and always confirm** — The confirmation prompt for project-scoped agents is a security measure. The LLM shouldn't be able to skip it. The existing `execute` logic already handles this correctly (checks for project-source agents, prompts via `ctx.ui.confirm`) — we just remove the parameter that gates it.

## Direction

Remove both parameters from the tool schema and the `AgentScopeSchema` definition. Hardcode `"both"` in the execute function. Remove the `confirmProjectAgents ?? true` conditional — always confirm. No other behavioral changes.

## Open questions

None.
