# Plan: Remove agentScope and confirmProjectAgents from subagent tool

## Context

Remove two LLM-facing tool parameters (`agentScope`, `confirmProjectAgents`) that shouldn't be model-controlled. Hardcode their behavior instead: always discover agents from both scopes, always confirm project-local agents. See [brainstorm](../brainstorms/subagent-tool-params.md).

## Architecture

### Impacted Modules

**Subagents Extension** — The only module affected. Changes are confined to the tool schema, execute function, and agent discovery interface:

- `agents.ts`: Remove the `AgentScope` type. Remove the `scope` parameter from `discoverAgents` — it always discovers from both user and project directories. The function signature becomes `discoverAgents(cwd: string)`. The internal branching on scope collapses to the current `"both"` path.

- `index.ts`: Remove `AgentScopeSchema` definition. Remove `agentScope` and `confirmProjectAgents` from the `subagent` tool's parameter schema. In `execute`, replace `params.agentScope ?? "user"` with the now-scopeless `discoverAgents(ctx.cwd)`. Remove the `params.confirmProjectAgents ?? true` conditional — always confirm when project agents are present and `ctx.hasUI` is true. The `before_agent_start` hook already calls `discoverAgents(process.cwd(), "both")` — update it to the new signature (no scope arg).

## Steps

### Step 1: Simplify `discoverAgents` in `agents.ts`

Remove the `AgentScope` type export. Remove the `scope` parameter from `discoverAgents` so the signature becomes `discoverAgents(cwd: string): AgentDiscoveryResult`. Collapse the internal branching to always load both user and project agents (the current `"both"` path): load `userAgents` unconditionally, load `projectAgents` when `projectAgentsDir` exists, merge with project overriding user on name collision.

**Verify:** `grep -n "AgentScope" extensions/subagents/agents.ts` returns nothing. The function signature has one parameter.
**Status:** not started

### Step 2: Update call sites and remove schema in `index.ts`

Three changes in `index.ts`:

1. **Imports** — Remove `AgentScope` from the `agents.js` import.
2. **`AgentScopeSchema`** — Delete the `StringEnum(["user", "project", "both"] ...)` definition.
3. **`before_agent_start` hook** — Change `discoverAgents(process.cwd(), "both")` to `discoverAgents(process.cwd())`.

**Verify:** `grep -n "AgentScope\|AgentScopeSchema\|agentScope" extensions/subagents/index.ts` returns nothing.
**Status:** not started

### Step 3: Strip parameters and simplify execute in the `subagent` tool

In the `subagent` tool registration in `index.ts`:

1. **Parameter schema** — Remove `agentScope` and `confirmProjectAgents` from the `parameters` Type.Object. Only `agents` remains.
2. **Execute body** — Remove `const agentScope: AgentScope = params.agentScope ?? "user";`. Replace `discoverAgents(ctx.cwd, agentScope)` with `discoverAgents(ctx.cwd)`. Simplify the confirmation conditional from `(agentScope === "project" || agentScope === "both") && (params.confirmProjectAgents ?? true) && ctx.hasUI` to just `ctx.hasUI` (always confirm when there's a UI and project agents are present).

**Verify:** `grep -n "confirmProjectAgents\|agentScope\|params\.agentScope" extensions/subagents/index.ts` returns nothing. The tool's parameter schema only contains `agents`.
**Status:** not started
