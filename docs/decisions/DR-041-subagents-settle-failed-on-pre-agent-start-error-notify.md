# DR-041: Subagents settle children as failed on error-level notify before agent_start

## Status
Accepted

## Context
A child pi process whose prompt is blocked (e.g., by quota enforcement) cannot make the RPC `prompt` command fail — pi's extension runner swallows input-handler throws (see DR-040). The blocked child emits an error-level `extension_ui_request` notify and returns `{ action: "handled" }`, leaving the prompt "successful" from RPC's perspective. Without a fix, the parent's `await_agents` would hang indefinitely waiting for an `agent_end` that never comes.

## Decision
`agent-set.ts` tracks `agentStartedSinceLastPrompt` per child entry. When a child emits a `notify` with `notifyType === "error"` while `state === "running"` and `!agentStartedSinceLastPrompt` (meaning the prompt was blocked before the LLM turn started), the entry is settled as failed with the notify text as `lastError`. A shared `settleFailed()` method handles both this path and the existing `agent_end` error path.

The fix is fully decoupled from quota — `agent-set.ts` contains no quota-specific logic.

## Consequences
Any extension in a child that emits an error-level notify at startup before `agent_start` — including genuinely non-blocking ones — will settle the child as failed. This false-positive risk is accepted as rare in practice (dismissed in code review). A future fix could let `agent_start` recover an entry settled via this path, rather than treating it as permanently failed.
