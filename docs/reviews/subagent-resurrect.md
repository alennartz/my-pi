# Review: Subagent Resurrect

**Plan:** `docs/plans/subagent-resurrect.md`
**Diff range:** `45e8cb753516d8135314211a0dd011bcaae7a66d..HEAD`
**Date:** 2026-05-02

## Summary

Plan adherence is strong: every step landed as described, and the XML/serializer changes match the Interfaces subsection cleanly. The headline concern is in the resurrect tool's spawn path — tool-set restrictions baked into specialist agent configs (e.g. `scout`'s read-only tool list) are silently dropped on resurrection, even though the prompt guidelines explicitly promise the resurrected agent inherits its tool set from the resumed session. Everything else is clean.

## Findings

### 1. Resurrected agents lose tool-set restrictions

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/index.ts:1083-1090` (resurrect tool spec build); interacts with `extensions/subagents/agent-set.ts:241-244` (PI_PARENT_LINK construction)
- **Status:** resolved

Tool gating for child agents is enforced at process spawn time via `PI_PARENT_LINK.tools` (`index.ts:221`), which `start()` populates from `agentConfig?.tools` (`agent-set.ts:241-244`). On the normal `subagent` path, `agentConfig` is found by name (`agentSpec.agent`) and the persona's tool list ends up in the env payload, restricting the child.

The resurrect handler builds the spec with `agent: undefined` (per Step 5: "Do not set `agent` or `model` — both are inherited from the resumed session"). In `start()`, `agentConfig = agentSpec.agent ? agentConfigs.find(...) : undefined` is therefore `undefined`, so `PI_PARENT_LINK` is sent without a `tools` field. In the child, `parentLink?.tools` is falsy, `allowedTools` becomes `null`, and `shouldRegisterTool` returns `true` for every tool. The resurrected agent ends up with the full default tool surface even if the original persona was tool-restricted.

This is observable contradiction: the resurrect tool's promptGuidelines (`index.ts:1051-1052`) tell the model "inherits its persona, model, and tool set from the resumed session — none of those can be changed here", but only the system-prompt persona text is actually inherited (because session resume replays the transcript). Tool restrictions live in env, not in the session bundle, and are silently lost.

The persisted JSONL log already carries the original persona name (`PersistedAgentRecord.agent`, populated from `entry.agentDef` in `agent-set.ts:292`). A fix can resolve the agent name by scanning `loadPersistedAgents(parentSessionFile)` for the record whose `sessionId` matches, then set `spec.agent` so `start()` re-applies the persona's tool list. (Persona system-prompt re-append is already correctly suppressed when `resumeSessionFile` is set, so setting `spec.agent` is safe.)

Risk: a torn-down `scout` (read-only) brought back via `resurrect` would have write/edit/spawn capabilities — a meaningful capability escalation across the teardown→resurrect boundary.

### 2. Plan Architecture text references a "plain-text wrapper" that doesn't exist

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/plans/subagent-resurrect.md` (Architecture / Impacted Modules, `index.ts` bullet)
- **Status:** resolved

The Impacted Modules subsection says: *"Extend the teardown tool's plain-text wrapper to append a one-line discovery hint pointing at `resurrect`."* The teardown tool has no plain-text wrapper — it returns the XML report directly. The Interfaces subsection later converges on "a single prose `<hint>` child element ... once per teardown call" inside the XML, which is what the implementation does (`messages.ts:65-70` and `messages.ts:97-100`). Implementation is correct; the Architecture bullet is just stale relative to the Interfaces decision. Worth fixing in the plan during cleanup so the doc is internally consistent. No code change needed.

### 3. `resolveSessionFile` matches by substring

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/agent-set.ts:471-473`
- **Status:** resolved

`resolveSessionFile` returns the first session filename that `.includes(sessionId)`. Because the input is always a full UUID surfaced from a teardown report and session filenames are themselves UUID-derived, real-world collisions are essentially impossible. But this is a substring match against arbitrary directory contents — if any non-session file ever lands in `<parent>.subagents/sessions/` whose name happens to include the UUID as a substring, it would be returned and then handed to pi as a `--session` argument. A stricter match (e.g. exact basename `${sessionId}.json` or whatever pi's actual naming convention is) would close that off. Low risk; flagging because the plan called out this exact resolver as an implementation choice and stricter is cheap.

## No Issues

- **Plan adherence:** Steps 1–6 all implemented as described. `AgentCompleteData.sessionId` is added and populated in both single and group teardown paths. XML serializers correctly emit `session_id` attributes and a single `<hint>` element per envelope, suppressed when no agent has a sessionId. `findLiveHolder` and `resolveSessionFile` exist on `SubagentManager` with the documented behavior. The `resurrect` tool is registered through the existing `shouldRegisterTool` gate, error messages match the four strings listed in the architecture, the spec construction reuses the `start()` resume path correctly, and dashboard/panel/stop-sequence wiring mirrors the `subagent` and `fork` tools. Test immutability is N/A — no upfront tests were written for this topic per the Tests section.
- **Code correctness (other axes):** No unhandled error paths beyond the ones noted; no race conditions visible (tool execution is serialized, and `findLiveHolder` runs against in-memory entries before `start()` mutates them); no resource leaks (RPC child lifecycle is unchanged from existing paths); persistence replay across parent restarts handles add→remove→add correctly because `loadPersistedAgents` matches removals by `sessionId`/`sessionFile`.
