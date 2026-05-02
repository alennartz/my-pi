# Plan: Subagent Resurrect

## Context

Add a `resurrect` tool to the subagents extension that brings a torn-down subagent back online from its session file, plus extend teardown output to surface each removed agent's session ID. Motivating use case: parent tears down too eagerly and later wants the worker back. See [docs/brainstorms/subagent-resurrect.md](../brainstorms/subagent-resurrect.md) for the full direction and reasoning.

## Architecture

### Impacted Modules

**Subagents extension** (`extensions/subagents/`) — only module touched.

- `index.ts` — register a new `resurrect` tool. Extend the teardown tool's plain-text wrapper to append a one-line discovery hint pointing at `resurrect`.
- `messages.ts` — extend `AgentCompleteData` with an optional `sessionId` field. Update `serializeAgentComplete` (single) and `serializeGroupComplete` (bulk) to include the UUID as a `session_id` attribute on each agent's tag.
- `agent-set.ts` — populate `AgentCompleteData.sessionId` when building completion reports. Add a `resurrect` method (or equivalent code path through `start()`) that takes a session UUID, resolves it to a child session file path, validates, and constructs a `RegularAgentSpec` with `resumeSessionFile` set. Add a helper to check whether a given UUID is currently held by a live agent.
- `persistence.ts` — no schema change needed; `PersistedAgentRecord` already tracks both `sessionFile` and `sessionId`. May expose a small lookup helper if used by the resolver.

The existing `RegularAgentSpec.resumeSessionFile` field, the `--session <path>` arg construction in `buildAgentArgs`, and the conditional that suppresses re-appending an agent definition's system prompt on resume (`agent-set.ts` ~L226) are all reused as-is. Fork already exercises the same identity-XML-on-resume code path, so no new ground there.

DR-021 (dynamic membership) and DR-022 (asymmetric topology for added agents) apply directly — `resurrect` is another way to add an agent to the existing set, with channels declared fresh at add time. No supersession.

### Interfaces

**Teardown report — XML extension.**

Single-agent (`<agent_idle>`) and group (`<group_complete>`) tags gain a `session_id` attribute on each per-agent element. A single prose `<hint>` child element — once per teardown call — describes the resurrection path so the model, scrolling back many turns later, can rediscover the feature from the transcript alone:

```xml
<agent_idle id="scout-1" status="idle" session_id="3adc73ee-27b3-420d-bc9f-73f37c244e2f">
...output...
<hint>Pass session_id to the resurrect tool to bring this agent back online with its prior conversation.</hint>
</agent_idle>

<group_complete>
  <summary>2 idle</summary>
  <agent id="scout-1" status="idle" session_id="3adc73ee-..." />
  <agent id="impl-1"  status="idle" session_id="9f2c0b91-..." />
  <hint>Pass any session_id above to the resurrect tool to bring an agent back online with its prior conversation.</hint>
  <usage .../>
</group_complete>
```

Failed agents may omit `session_id` if no session file was ever produced; otherwise it is included.

**Brainstorm deviations.** Two intentional differences from [docs/brainstorms/subagent-resurrect.md](../brainstorms/subagent-resurrect.md):

- *Format.* Brainstorm called for plain-text reminder lines outside the XML. The existing teardown report is already XML, and putting `session_id` as an attribute alongside `id` and `status` is structurally consistent with the rest of the report. The prose hint stays inside the XML as a `<hint>` child element rather than as a separate plain-text line.
- *Hint frequency.* Brainstorm called for one reminder per removed agent. Plan emits one `<hint>` per teardown call (always co-located with the session IDs in the same XML envelope), since the session IDs themselves are already per-agent and a repeated reminder line would be noise.
- *Handle shape.* Brainstorm framed the handle as the session file path. Plan uses the UUID `sessionId` instead — shorter, opaque, looks like an id; resolution to file path is internal. Future-proof: if pi's `--session` ever accepts UUIDs, the resolver can be dropped.

**Cross-restart property preserved.** Because the session ID lives in the parent's transcript and child session files are colocated with the parent session bundle (`<parent>.subagents/sessions/`), resurrection works the same whether the parent is the same live process or a fresh process resuming a parent session from a prior day. The resolver works against the on-disk sessions directory, which is initialized lazily by `start()` regardless of whether infrastructure was previously up.

**Type extension.**

```ts
interface AgentCompleteData {
  id: string;
  status: "idle" | "failed";
  output?: string;
  error?: string;
  sessionId?: string;   // NEW
}
```

**`resurrect` tool — schema.**

```ts
{
  id: string,                  // parent-assigned; must not collide with a live agent
  sessionId: string,           // UUID surfaced by a prior teardown
  channels: string[],          // re-declared fresh; siblings may not exist anymore
  task: string,                // required directive the agent runs on resurrection
}
```

No `agent`, `model`, or persona fields — those are baked into the session and inherit automatically. The tool description and prompt guidelines should explicitly tell the model: this brings back a previously-torn-down agent using the `session_id` from a teardown report.

**`resurrect` tool — behavior.**

1. Ensure the parent's child-sessions directory exists. If it does not (no subagent has ever been spawned for this parent), error: "no prior subagents to resurrect." If subagent infrastructure is not yet running but the directory exists, it will be brought up by the underlying `start()` call — same lazy-init path as `subagent`/`fork`.
2. Resolve `sessionId` → child session file path. Implementation choice (impl phase): either scan `<parent>.subagents/sessions/` for a filename containing the UUID, or read `agents.jsonl` for a record with matching `sessionId`. If no match, error.
3. Reject if any currently-live agent's `sessionId` equals the requested one (double-resurrection foot-gun — would have two processes writing to the same session file).
4. Reject if `id` collides with a currently-live agent (existing `start()`-side check already does this; surface the error cleanly).
5. Construct a `RegularAgentSpec` with `kind: "agent"`, `agent: undefined`, `model: undefined`, `resumeSessionFile: <resolved path>`, `channels`, `task`, `id`.
6. Call `manager.start([spec], agentConfigs)`. The existing path handles spawning, broker integration, identity XML appending, prompt delivery, and persistence logging.

**Manager helpers.**

```ts
class SubagentManager {
  // Returns the live agent's id holding this session UUID, or undefined.
  findLiveHolder(sessionId: string): string | undefined;

  // Resolves a session UUID to a child session file path within this parent's
  // sessions dir. Returns undefined if not found.
  resolveSessionFile(sessionId: string): string | undefined;
}
```

These are thin lookups; both can be inlined into the tool handler if simpler, but exposing them keeps the manager as the single source of truth for entry/file mappings.

**Errors surfaced to the model:**

- `"No subagent infrastructure for this parent session — nothing to resurrect."`
- `"No session found with id <uuid>."`
- `"Session <uuid> is currently held by live agent <id>; teardown that agent first or use a different one."`
- `"Agent id <id> is already in use; pick a different id."`

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

## Steps

### Step 1: Extend `AgentCompleteData` with `sessionId`

In `extensions/subagents/messages.ts`, add an optional `sessionId` field to `AgentCompleteData`:

```ts
export interface AgentCompleteData {
  id: string;
  status: "idle" | "failed";
  output?: string;
  error?: string;
  sessionId?: string;
}
```

No other types in this file change.

**Verify:** TypeScript shape matches; downstream call sites in `agent-set.ts` will be updated in Step 2 to populate it.
**Status:** not started

### Step 2: Populate `sessionId` in completion reports

In `extensions/subagents/agent-set.ts`, `SubagentManager.getCompletionReport()` builds the per-agent `AgentCompleteData` array from `this.entries`. Add `sessionId: e.sessionId` to each mapped entry. In `teardownSingle()`, the local `data: AgentCompleteData` is built from `entry` directly — also include `sessionId: entry.sessionId` there.

No other changes in this file for this step.

**Verify:** Single-agent and group teardown paths both attach the entry's `sessionId` (already captured from `rpc.sessionId` at spawn time on agent-set.ts ~L246) to the completion data passed into the serializers.
**Status:** not started

### Step 3: Emit `session_id` attribute and `<hint>` in serializers

In `extensions/subagents/messages.ts`:

- `serializeAgentForXml(agent)` (used by `serializeAgentComplete`): when `agent.sessionId` is present, add `session_id="<escaped>"` to the `<agent_idle>` opening tag (alongside `id` and `status`), for both the `failed` and `idle` branches. Append a `<hint>` child element with the resurrection prose before the closing `</agent_idle>`.
- `serializeGroupComplete(data)`: for each `<agent ... />` line, include `session_id="<escaped>"` when present. Insert one `<hint>...</hint>` line after the per-agent lines and before the `<usage .../>` line.

Hint text:

- Single-agent: `"Pass session_id to the resurrect tool to bring this agent back online with its prior conversation."`
- Group: `"Pass any session_id above to the resurrect tool to bring an agent back online with its prior conversation."`

Omit the `session_id` attribute (and the `<hint>`, when no agent in the report has one) if `sessionId` is undefined.

**Verify:** Snapshot or string-match tests for the new XML shape — `session_id` attribute present when populated, `<hint>` appears exactly once per teardown envelope.
**Status:** not started

### Step 4: Add live-holder and session-file lookup helpers on `SubagentManager`

In `extensions/subagents/agent-set.ts`, add two public methods to `SubagentManager`:

```ts
findLiveHolder(sessionId: string): string | undefined;
resolveSessionFile(sessionId: string): string | undefined;
```

- `findLiveHolder` scans `this.entries` and returns the `id` of any entry whose `sessionId === sessionId`, or `undefined`.
- `resolveSessionFile` resolves a UUID to a child session file path. Implementation: if `this.sessionDir` is set, list files in it and return the absolute path of the first whose basename contains the UUID; otherwise compute the parent's persistence paths via `getPersistencePaths(this.opts.parentSessionFile)` (import from `./persistence.js`) and scan that `childSessionsDir`. Returns `undefined` if the directory does not exist or no match is found.

This method must work both before and after subagent infrastructure has been initialized, since `resurrect` may be the first subagent operation in a fresh parent process resuming an old session.

**Verify:** Manual call from a unit test or scratch driver — given a known UUID present in `<parent>.subagents/sessions/`, `resolveSessionFile` returns the matching file path; `findLiveHolder` returns the live agent id when one holds the UUID and `undefined` otherwise.
**Status:** not started

### Step 5: Register the `resurrect` tool in `index.ts`

In `extensions/subagents/index.ts`, register a new tool gated by `shouldRegisterTool("resurrect")`. Schema:

```ts
parameters: Type.Object({
  id: Type.String({ description: "Unique identifier for the resurrected agent among the parent's active agents" }),
  sessionId: Type.String({ description: "session_id surfaced by a prior teardown report" }),
  channels: Type.Array(Type.String(), { description: "Peer agent ids this agent can send to (re-declared fresh; siblings from the prior generation may not exist)" }),
  task: Type.String({ description: "Directive the agent runs on resurrection" }),
}),
```

Description: `"Bring a previously-torn-down subagent back online from its session file."` Prompt guidelines should explain: this revives an agent torn down earlier; pass the `session_id` from a prior `<agent_idle>` or `<group_complete>` teardown report; persona, model, and tools are inherited from the resumed session and cannot be changed; channels must be re-declared because siblings from the prior generation may no longer exist.

Execute body:

1. Call `ensureManager(ctx)` to obtain the manager (lazy-init if needed).
2. Reject with `"Agent id \"<id>\" already exists"` if `mgr.getAgentStatus(params.id)` is truthy.
3. Call `mgr.findLiveHolder(params.sessionId)`. If it returns a live id, throw: `` `Session ${params.sessionId} is currently held by live agent ${holder}; teardown that agent first or use a different one.` ``.
4. Call `mgr.resolveSessionFile(params.sessionId)`. If `undefined`, distinguish the two error cases: if the parent's `childSessionsDir` does not exist (`fs.existsSync(getPersistencePaths(ctx.sessionManager.getSessionFile()).childSessionsDir) === false`), throw `"No subagent infrastructure for this parent session — nothing to resurrect."`; otherwise throw `` `No session found with id ${params.sessionId}.` ``.
5. Build a `RegularAgentSpec`:
   ```ts
   const spec: RegularAgentSpec = {
     kind: "agent",
     id: params.id,
     task: params.task,
     channels: params.channels,
     resumeSessionFile: <resolved path>,
   };
   ```
   Do not set `agent` or `model` — both are inherited from the resumed session.
6. Call `await ensureWidget(ctx)`, then `await mgr.start([spec], discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined).agents)`, then `await ensureParentBrokerClient()`.
7. Refresh widget/panel like the `subagent` tool does (`dashboard.update(...)`, `panelHandle.updateCards(...)`).
8. `stopSequences.addOnce("<agent_idle")`.
9. Return `{ content: [{ type: "text", text: ack }] }` where `ack` is the string returned by `mgr.start`.

The existing `start()` path already handles the resume code path (suppressing agent-definition system prompt re-append when `resumeSessionFile` is set, appending identity XML, persistence logging, broker integration, prompt delivery via `entry.rpc.prompt`).

**Verify:** End-to-end: spawn an agent → teardown → call `resurrect` with the surfaced `session_id` → resurrected agent appears in the dashboard, picks up the new task, and its prior conversation is visible in the session file. Error paths return the four messages listed in the architecture.
**Status:** not started

### Step 6: Wire the new tool into prompt overlays / overlays metadata

No separate overlay file lists tools. Confirm the new `resurrect` tool appears in pi's tool listing automatically via `pi.registerTool` and that the tool gating list (when `parentLink.tools` is set) does not silently strip it from a parent that should have it. No code change expected unless a test exposes a gap; otherwise, this is a verification-only step.

**Verify:** Running pi with the subagents extension loaded, `resurrect` shows in `--list-tools` (or equivalent introspection) and is callable from the parent agent. A child agent with a tools restriction that does not include `resurrect` does not see it.
**Status:** not started

