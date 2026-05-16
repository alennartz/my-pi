# Plan: Subagent CWD

## Context

Add an optional per-agent `cwd` to the `subagent` tool so a parent agent can spawn subagents that operate in a different working directory — primarily for orchestrating work across multiple projects from a single hub agent. From the subagent's perspective the experience should be "as if pi were freshly launched in that folder."

See [docs/brainstorms/subagent-cwd.md](../brainstorms/subagent-cwd.md) for exploration and decision rationale.

## Architecture

### Impacted Modules

**Subagents** (`extensions/subagents/`) — the only module touched.

- `index.ts` (subagent tool handler) gains a `cwd` field on `AgentItem`, plus pre-spawn resolution/validation alongside the existing batch-level checks (duplicate ids, model resolution).
- `agents.ts` adds an optional `cwd` to `RegularAgentSpec`. `ForkAgentSpec` is intentionally **not** extended — fork excludes cwd by design (see brainstorm).
- `agent-set.ts` (`SubagentManager` / `AgentSet.start`) selects the per-spec `cwd` over its constructor-level default when constructing each `RpcChild`. No structural change — `RpcChild` already accepts a `cwd`.
- `persistence.ts` adds an optional `cwd` field to `PersistedAgentRecord` and the `agent_added` lifecycle event. Without this, a parent restart would silently relocate restored subagents into the parent's cwd. Older log records without the field continue to restore correctly (treated as "no override").

No new modules. No technology choices. No fork or resurrect changes — the `fork` and `resurrect` tool schemas simply don't declare a `cwd` field, so existing TypeBox validation rejects any attempt to pass one. No explicit guard needed.

### Interfaces

**Tool schema (`subagent` → `AgentItem`)** gains an optional `cwd`:

```ts
const AgentItem = Type.Object({
  id: Type.String({ ... }),
  agent: Type.Optional(Type.String({ ... })),
  model: Type.Optional(Type.String({ ... })),
  task: Type.String({ ... }),
  channels: Type.Optional(Type.Array(Type.String(), { ... })),
  cwd: Type.Optional(Type.String({
    description:
      "Working directory for this agent. Relative paths resolve against the parent's cwd. " +
      "Defaults to the parent's cwd. The subagent boots as if pi were freshly launched in this directory — " +
      "its AGENTS.md, project agents, and project skills are discovered relative to it.",
  })),
});
```

**Spec type (`RegularAgentSpec`)** gains an optional `cwd` carrying the *already-resolved absolute path*:

```ts
export interface RegularAgentSpec {
  kind: "agent";
  id: string;
  agent?: string;
  model?: string;
  task: string;
  channels?: string[];
  resumeSessionFile?: string;
  cwd?: string;  // absolute; resolved & validated by the tool handler
}
```

**Resolution & validation contract (in the `subagent` tool handler):**

For each agent spec with a `cwd`:
1. If the path is not absolute, resolve it against `ctx.cwd` (the parent's cwd) using `path.resolve(ctx.cwd, params.cwd)`.
2. `fs.statSync` the resolved path. Fail if it does not exist or is not a directory.
3. Replace the spec's `cwd` with the resolved absolute path before it reaches `SubagentManager.start`.

Failures are **atomic for the spawn batch** — if any agent's `cwd` is invalid, none of the agents in the call spawn. This matches existing pre-spawn checks (duplicate ids, model validation): all-or-nothing batch validation before any `RpcChild` is constructed.

Error messages identify the offending agent by id and the resolved path that failed, e.g. `Agent "worker-2" has invalid cwd: "/abs/path/that/doesnt/exist" does not exist or is not a directory`.

**Spawn-time selection (in `AgentSet.start`):** when constructing each `RpcChild`, use `agentSpec.cwd ?? this.opts.cwd`. The fallback path is the manager's constructor-level cwd (parent's cwd), preserving today's behavior for specs without an override.

**Persistence contract:**

```ts
export interface PersistedAgentRecord {
  id: string;
  kind: AgentSpec["kind"];
  task: string;
  channels: string[];
  agent?: string;
  sessionFile: string;
  sessionId?: string;
  cwd?: string;  // absolute; absent for legacy records and for agents using the parent default
}
```

On restore, `cwd` is read back into the reconstituted `RegularAgentSpec` and flows through the same `agentSpec.cwd ?? this.opts.cwd` selection. Legacy records (no field) restore as if no override was given.

**Restore-time validation:** when restoring an agent with a persisted `cwd`, re-validate the path the same way as at spawn time (exists, is a directory). If validation fails (e.g. the target project was moved or deleted between sessions), **skip that agent during restore** and append an `agent_removed` lifecycle event citing the invalid cwd as the reason. Other restored agents are unaffected — this is an independent failure, not a batch failure. Matches the brainstorm's "fail fast, don't be magic" principle: a silently relocated agent (falling back to the parent's cwd) would be worse than visibly missing.

### Precedence

Tool-call `cwd` is the only level — there is no definition-level `cwd` on `AgentConfig`. If a definition-level default is ever wanted later, it's an additive change; for now it's out of scope (it would harm agent-definition portability across machines, and the hub-orchestration use case doesn't require it).

### Propagation

When a subagent is spawned into project B, it boots its own pi process with `cwd=B`. Its own use of `subagent` defaults to cwd=B for its children — this falls out of `ctx.cwd` in *its* tool handler being B. No special handling required.

### Asymmetry: agent identity is parent-resolved

The "as if pi were freshly launched there" promise covers everything the child pi discovers from its cwd at boot: `AGENTS.md`, project agents available to *that subagent's own* `subagent` calls, and project skills it discovers for its own use. It does **not** cover the identity of the spawned agent itself — when the parent says `agent: "scout"`, the parent resolves "scout" against its own project agents and bakes the system prompt + skill paths into CLI args (existing behavior). This is the right semantics in practice (`agent: "scout"` should mean the same thing regardless of target directory) but worth knowing about.

### Relationship to existing decisions

- **DR-027 (session replacement for worktree transitions)** establishes that cwd is captured at session creation and operating in a different directory requires a fresh session there. This feature is a clean instance of that principle — a subagent already *is* a fresh pi session, so giving it a different cwd at spawn time is the natural extension. Not superseded; reinforced.
- **DR-016 (extension-level agent discovery via resource metadata)** is what makes the "as if freshly launched" semantics work for free — the child pi's `session_start` calls `discoverPackageAgents(ctx.cwd)` rooted in the new directory.

No DR supersessions.

## Tests

**Pre-test-write commit:** `e125e50968df041bc1a64933e1707874adebdf2c`

### Interface Files

- `extensions/subagents/agents.ts` — added optional `cwd` to `RegularAgentSpec`; exported new `AgentCwdInput` shape, `isValidCwd(absPath)` predicate, and `resolveAgentCwds(agents, parentCwd)` batch-atomic resolver/validator. Stubs throw `not implemented`.
- `extensions/subagents/persistence.ts` — added optional `cwd` to `PersistedAgentRecord`; plumbed cwd through `loadPersistedAgents` and `findAgentRecordBySessionId` read-back (the `agent_added` writer already spreads the full record); exported new `pruneInvalidPersistedAgents(paths, agents, isCwdValid)` for restore-time validation. Stub throws `not implemented`.
- `extensions/subagents/index.ts` — added `cwd: Type.Optional(Type.String(...))` to the `subagent` tool's `AgentItem` schema with the description from the architecture.

### Test Files

- `extensions/subagents/cwd.test.ts` — exercises `isValidCwd` (directory / missing / file) and `resolveAgentCwds` (absolute pass-through, relative resolution against `parentCwd`, omission of cwd-less agents, batch atomicity on invalid entries, error messages identifying agent id and resolved path, empty batch).
- `extensions/subagents/persistence.test.ts` — exercises the cwd round-trip through `appendAgentAdded` / `loadPersistedAgents` / `findAgentRecordBySessionId`, legacy log lines (no cwd field) restoring as cwd-less records, and `pruneInvalidPersistedAgents` (keeps valid, keeps cwd-less unconditionally without invoking the validator, drops invalid, independent per-record failures, emits `agent_removed` events that cancel the agent on next load, empty input).

### Behaviors Covered

#### `isValidCwd` (agents.ts)

- Returns `true` for an existing directory at the given absolute path.
- Returns `false` when the path does not exist.
- Returns `false` when the path exists but is a file rather than a directory.

#### `resolveAgentCwds` (agents.ts)

- Returns an empty map when no input has a `cwd`.
- Absolute paths that point at existing directories are returned unchanged in the result map, keyed by agent id.
- Relative paths are resolved against `parentCwd` and the resulting absolute path is what appears in the map.
- Agents without a `cwd` are omitted from the result map (so callers can use `agentSpec.cwd ?? this.opts.cwd` at spawn time).
- A `cwd` that does not exist causes a throw whose message contains both the offending agent's id and the resolved (absolute) path that failed.
- A `cwd` that exists but is not a directory (e.g. a file) causes a throw.
- When a relative `cwd` is invalid, the error message references the resolved absolute path, not the relative input.
- Validation is **atomic for the batch**: if any agent's `cwd` is invalid, the function throws and never returns a partial result map.
- Validation covers every entry, not just the first — a later invalid entry still triggers a throw mentioning that entry's id.
- An empty input batch returns an empty map.

#### `PersistedAgentRecord` cwd round-trip (persistence.ts)

- A record written with `cwd` via `appendAgentAdded` is loaded back through `loadPersistedAgents` with `cwd` intact.
- A record written without `cwd` loads back with `cwd` undefined.
- Legacy JSONL lines that pre-date the `cwd` field load successfully as records with `cwd` undefined (no override).
- `findAgentRecordBySessionId` exposes the persisted `cwd` when present and returns undefined when absent.

#### `pruneInvalidPersistedAgents` (persistence.ts)

- Records whose persisted `cwd` still passes the `isCwdValid` predicate are kept.
- Records with no `cwd` are kept unconditionally — the predicate is never invoked for them.
- Records whose `cwd` no longer validates are dropped from the returned array.
- Per-record failures are independent: one record's invalid `cwd` does not affect others in the batch.
- For each dropped record, an `agent_removed` lifecycle event is appended to the log, so the dropped agent does not reappear in a subsequent `loadPersistedAgents` call.
- An empty input list returns an empty array (no log writes).
