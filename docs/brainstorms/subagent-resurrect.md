# Subagent Resurrect

## The Idea

Add a way to bring a torn-down subagent back online from its session file. Today, `teardown` is final — once an agent is removed, its conversation is gone from the parent's reach. Sometimes the parent realizes it tore down too eagerly and wants the worker back, often many turns later.

The mechanics already exist: `resumeSessionFile` is an established concept used by spawn and fork, child session files live in `<parent>.subagents/sessions/` and are never garbage-collected. The missing pieces are surfacing the session ID at teardown so the parent can find it later, and giving the parent a tool to reattach.

## Key Decisions

### Use case is "undo the teardown"

Scope is single-process recovery, not cross-session handoff or persistent specialists parked between conversations. The motivating scenario: parent tears down, conversation continues, parent later realizes it needs something from that worker.

### Spawn-from-session, not restore-in-place

Resurrect creates a *new* agent (parent picks the id, declares channels fresh) that happens to inherit the prior conversation. It does not try to restore the agent's original id slot or reconnect prior channels. Rationale: by the time resurrection happens — typically much later — there's no guarantee siblings still exist, and the parent may not want them coming back. Spawn-from-session matches what the existing `resumeSessionFile` machinery already does and avoids questions like "what if the original id is now taken" or "what if the infrastructure was torn down because this was the last agent."

### Separate `resurrect` tool, not an overload on `subagent`

Overloading `subagent` with a `resumeSession` field would make several existing fields (`agent`, `model`) conditionally meaningless and force the description to explain two modes. A separate tool keeps each schema crisp, gives the model a discoverable name with its own description, and matches the precedent already set by `fork` (which is also its own tool despite sharing mechanics with `subagent`). Models tend to use overloaded tools poorly.

### Session ID lives in the parent's transcript, not in memory

The session ID returned from `teardown` is durable enough by virtue of being in the parent's conversation history. There's no need for an in-memory registry or a discovery mechanism — when the parent (potentially after a pi restart that resumes the parent session) wants to resurrect, it scrolls back, finds the teardown output, and passes the ID to `resurrect`. This collapses "same process" and "across restarts" into the same trivial case.

### Task on resurrect is required

Mirrors `subagent`. Resurrection without a directive is rare in practice — if you're bothering to bring an agent back, you have something for it to do. Required task avoids a useless "spawn idle then immediately send" two-step and keeps the mental model uniform across all agent-creating tools.

### Teardown surfaces the session ID with a usage hint

Both single-agent and group teardown append a clearly-labeled line per removed agent: the session ID/path plus a short hint pointing at the `resurrect` tool. Plain text, not XML — the model is reading, not parsing. The hint matters more than the format: the whole feature only works if the model, mid-conversation many turns later, *thinks of* resurrection. A self-explanatory teardown output makes that path discoverable from transcript history alone, with no need for the model to remember the tool exists.

## Direction

Add a `resurrect` tool to the subagents extension that reattaches a fresh worker process to a previously-torn-down session.

**Teardown change.** Single-agent and group teardown both include a per-agent line in their return value: the session ID/path plus a one-liner usage hint pointing at `resurrect`.

**`resurrect` tool params:**
- `id` — parent-assigned, must not collide with a live agent.
- `sessionId` — the path surfaced by a prior teardown.
- `channels` — re-declared fresh; siblings from the prior life are not assumed to exist.
- `task` — required; the directive the resurrected agent starts working on.

Agent definition, system prompt, and model are baked into the session and inherit automatically — they are not re-specified at resurrection.

**Error cases:**
- Missing/invalid session file → error.
- `id` collides with a currently live agent → error.
- `sessionId` is currently held by a live agent (double-resurrection foot-gun, which would have two processes writing to the same session file) → error.

## Open Questions

None.
