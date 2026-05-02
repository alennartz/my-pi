# DR-033: Resurrect Re-Resolves Persona Name from the Persistence Log So Tool Gating Survives

## Status
Accepted

## Context

Tool restrictions for child agents in the subagents extension are enforced at process spawn time via `PI_PARENT_LINK.tools` — an env var that `start()` populates from the named persona's `agentConfig.tools`. The persona's *system prompt* lives in the resumed session bundle and is correctly preserved by `--session`. Tool restrictions do not — they live in env, not in the transcript.

The first cut of `resurrect` built its `RegularAgentSpec` with `agent: undefined`, following the brainstorm's framing that persona is inherited from the session. This silently dropped the env-side restrictions: a torn-down `scout` (read-only) came back with the full default tool surface — capability escalation across the teardown→resurrect boundary. Caught in code review.

## Decision

At resurrect time, look up the original persona name from the JSONL persistence log (`PersistedAgentRecord.agent`, keyed by `sessionId`) via a `findPersistedAgentName` helper on `SubagentManager`, and pass it as `spec.agent`. `start()` then re-applies the persona's tool list to `PI_PARENT_LINK.tools`. The persona's system-prompt re-append remains correctly suppressed because `resumeSessionFile` is set, so there's no double-prompt risk.

Rejected alternatives:

- **Leave `agent` undefined and rely on the resumed session.** The original draft. Silently capability-escalates, because the env channel isn't part of the session bundle.
- **Encode the allowed-tool list into the session bundle.** Duplicates persona config, requires a session-format schema change, and doesn't generalize to other env-baked invariants. Re-resolving by name keeps the persona definition as the single source of truth.
- **Re-ask the model to declare tools at resurrect.** Contradicts the design promise that persona is inherited; also pushes a security-relevant decision onto the model.

## Consequences

The persistence log becomes load-bearing for a security-relevant invariant: `PersistedAgentRecord.agent` cannot be removed without breaking `resurrect`'s tool gating. Any future refactor of the persistence schema must preserve this field or migrate the lookup.

Behavior is also coupled to the persona name still being resolvable at resurrect time. If a persona is renamed or removed between teardown and resurrect, `start()` falls back to "no agentConfig" and silently drops restrictions again. Mitigation is left to operational discipline for now; if persona churn becomes a real problem, the alternative is to snapshot the resolved tool list into the persistence record at spawn time so the env-side gate is reconstructable without re-resolution.
