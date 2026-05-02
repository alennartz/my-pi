# DR-032: Resurrect as a Separate Tool, with `session_id` Surfaced in the Teardown Transcript

## Status
Accepted

## Context

Mechanics for resuming a child session already existed in the subagents extension (`resumeSessionFile`, used by spawn and fork). What was missing for "undo the teardown" was a way for the parent to rediscover a torn-down agent later — possibly many turns later, and possibly across a pi restart that resumed the parent session. Without a discovery path, the resume mechanics were unreachable from a parent that had already let a worker go.

## Decision

Add a separate `resurrect` tool to the subagents extension. Each removed agent's `session_id` is emitted as an attribute on its `<agent_idle>` / `<agent>` element in the teardown XML report, plus a single `<hint>` child element per envelope pointing at the tool. No in-memory registry, no out-of-band persistence — the parent's own conversation transcript carries the handle.

Rejected alternatives:

- **Overload `subagent` with a `resumeSession` field.** Would make `agent` and `model` conditionally meaningless and force the tool description to explain two modes. Models use overloaded tools poorly. Precedent: `fork` is also a separate tool despite sharing the same `resumeSessionFile` mechanics.
- **In-memory or out-of-band registry.** Unnecessary. Putting the id in the transcript collapses "same process" and "across a pi restart that resumed the parent" into the same trivial case — both retrieve the id by scrolling back.
- **File path as the handle.** UUID is shorter, opaque, and future-proof if pi's `--session` ever accepts UUIDs natively (the internal resolver helper would then drop out).
- **One `<hint>` per agent (the brainstorm's framing).** Repeated reminder lines are noise when the per-agent `session_id` is already co-located in the same XML envelope; one hint per envelope is enough to make the feature discoverable.

## Consequences

Resurrection is discoverable from transcript history alone — the model rediscovers the feature mid-conversation by reading a prior teardown report, with no need to "remember" the tool exists. Cross-restart works for free with no extra plumbing, because session files live under the parent's bundle and the session_id lives in the parent's transcript.

Costs: the subagents extension owns a new tool registration, and `SubagentManager` carries two thin lookup helpers (`findLiveHolder`, `resolveSessionFile`). The hint-in-XML is mildly unconventional (XML reports usually don't editorialize), but the discoverability payoff is the whole point of the feature — without the hint, the `session_id` attribute is just inert metadata.
