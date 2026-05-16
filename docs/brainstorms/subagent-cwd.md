# Subagent CWD

## The idea

Let a parent agent spawn subagents that operate in a different working directory than the parent — primarily to orchestrate work across multiple projects from a single hub agent.

The intended feel: from the subagent's perspective, it should be **as if pi were freshly launched in that folder**. Its `AGENTS.md`, its project agents, its project skills — all the things pi normally discovers from `cwd` at startup — should come from the new directory, not the parent's.

## Key decisions

### Scope: `subagent` tool only

`subagent` (fresh agent) gets a per-spec `cwd`. `fork` and `resurrect` do **not**.

- **Fork is excluded** because a fork carries the parent's full conversation history. Putting that context into a different repo gives the forked agent a memory of project A while it physically operates in project B — semantically muddled with no clear use case.
- **Resurrect is excluded** because a resurrected agent restores from a recorded session whose original cwd is part of its identity. Letting `cwd` differ on resurrection means the agent's working directory mutates across lifetimes — also muddled.

If a real use case for either appears later, revisit. Until then, narrow scope keeps the semantics clean.

### Per-agent in the array, not per-call

The `subagent` tool takes `agents[]` — multiple agents per call. The `cwd` field lives on each individual spec, not on the call as a whole.

Reason: the obvious use case is fanning out one agent per project in a single call. A call-level `cwd` would force one call per project and defeat the ergonomics.

### Path semantics

- **Relative paths** are resolved against the parent agent's current cwd, then converted to absolute before being passed to the child process. (Matches how a shell user thinks; avoids any ambiguity about what the child sees.)
- **Absolute paths** used as-is.
- **Validation**: hard-fail at spawn time if the resolved path doesn't exist or isn't a directory. No auto-create — too magic, and if the directory genuinely isn't there yet, the caller should know rather than silently get a fresh empty workspace.

### Propagation is automatic, no extra work

When a subagent is spawned into project B, it boots its own pi process with cwd=B. If that subagent itself uses `subagent`, the default cwd for its children is B (because the spawning extension lives in *its* pi process, in *its* cwd). This is the natural and desired behavior — no special handling needed.

### Asymmetry: agent identity is resolved in the parent's universe

The "as if pi were freshly launched there" promise applies to everything the **child pi discovers at boot from its cwd**:

- `AGENTS.md` (auto-loaded by pi from the new cwd)
- Project agents available to *that subagent* when it itself calls `subagent`
- Project skills the child discovers for its own use
- The child's own working directory for tool calls (`ls`, `bash`, `read`, etc.)

It does **not** apply to the identity of the spawned agent itself. When the parent says `agent: "scout"`, the parent resolves "scout" against *its own* project agents and bakes the system prompt + skill paths into CLI args for the child. So the specialist used to define the spawned agent comes from the parent's universe, not the target project's.

This is the right behavior in practice — `agent: "scout"` should mean the same thing regardless of where the subagent is going — but worth knowing so the asymmetry doesn't surprise anyone later.

## Direction

Add an optional `cwd` field to each entry in the `subagent` tool's `agents[]` parameter. When present:

1. Resolve to absolute (relative to parent's cwd if not already absolute).
2. Validate existence and that it's a directory; fail fast otherwise.
3. Pass through to `RpcChild`'s existing `cwd` option.
4. Everything else falls out: child pi runs `session_start` against the new cwd, discovers project context from there, and propagates naturally to its own children.

No changes to `fork` or `resurrect`. No changes to how the parent resolves agent specialists.

## Open questions

None at this point — the feature is small enough that test-writing and impl-planning should resolve any remaining mechanical questions.
