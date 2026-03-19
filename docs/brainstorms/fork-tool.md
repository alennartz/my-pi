# Brainstorm: Fork Tool for Subagents Extension

## The Idea

Add a `fork` tool to the subagents extension that lets an agent fork itself into a new sub-agent context. The fork branches from the parent's current session (full conversation history, same persona, same tools/skills) and receives an injected task message. It appears as a sub-agent in the existing group infrastructure.

This is a lightweight alternative to the full `subagent` tool when the agent just needs to offload a single task to a fresh context that shares its own history and configuration.

## Key Decisions

### Fork is a group of one
The fork creates a single-agent group using the existing `GroupManager` machinery — broker, widget, notifications, send/respond, teardown all work unchanged. No new lifecycle model. One fork at a time (same constraint as one active group at a time).

**Why:** The group infrastructure already handles everything needed. A fork is syntactic sugar over a single-agent group, not a new concept. Reuse avoids duplicating lifecycle management, widget rendering, and messaging.

### Session branching via `--fork`
The forked RPC child is spawned with `pi --mode rpc --fork <parent-session-file>`. This gives it the parent's full conversation history. No compaction before forking — the inherited context is used as-is, with auto-compaction handling overflow if needed.

**Why:** `--fork` is the existing pi mechanism for session branching. It copies history into a new session file. The fork starts where the parent left off, which is the whole point — the sub-agent has the same context the parent has been building.

### Explicit CLI args for configuration (not inferred from session)
The session file stores conversation history but does NOT store CLI configuration (active tools, skills, agent file, system prompt, thinking level). These are resolved at startup from CLI args and project discovery. So the fork tool must explicitly pass:
- `--tools <filtered-builtin-tools>` — from `pi.getActiveTools()`, filtered to built-in tools only (read, bash, edit, write, grep, find, ls). Extension-registered tools (subagent, send, respond, etc.) are added by extensions at runtime.
- `--skill <path>` — for each skill, from `pi.getCommands()` filtered for `source === "skill"`
- `--thinking <level>` — from `pi.getThinkingLevel()`

Extensions, prompt templates, and themes are discovered from the project directory (same cwd), so no args needed for those.

**Why:** The session file is a message log, not a config snapshot. Without explicit args, the fork could end up with different tool restrictions or skills than the parent, breaking the "true fork" contract.

### Identity XML still injected
The fork gets `--append-system-prompt` with identity XML (same as regular sub-agents) so it knows it's a sub-agent and can communicate with the parent via send/respond. `PI_PARENT_LINK` env var is also set for broker connection.

**Why:** Without identity injection and broker connection, the fork would be isolated — no way for parent to communicate with it or receive results beyond the `<agent_complete>` notification.

### Session files cleaned up on teardown
The forked session file (created by `--fork`) is deleted when the group is torn down. Regular subagents use `--no-session` (ephemeral), but `--fork` and `--no-session` are mutually exclusive, so forking inherently creates a session file. We clean it up manually to keep forks ephemeral like other subagents.

**Why:** Consistency with regular subagents — sub-agent session files are implementation details, not things the user should see in `/resume`. The fork's session file is a side effect of using `--fork`, not a feature.

## Direction

Implement `fork` as a new tool in the subagents extension with a single `task` parameter. It:
1. Gets the parent's session file, active tools, skills, and thinking level
2. Constructs a single-agent group spec with fork metadata
3. Feeds it through the existing group creation path in `GroupManager`
4. `GroupManager` detects the fork spec and uses `--fork <session>` plus explicit config args instead of `buildAgentArgs()`
5. After startup, the task is sent as the fork's initial prompt
6. All existing group machinery (broker, widget, notifications, teardown) works unchanged

Implementation surface: small changes to `group.ts` (fork-aware arg building) and `index.ts` (new tool registration).

## Open Questions

- **Prompt guidelines for the LLM** — how should we guide the agent on when to use `fork` vs `subagent`? Fork is for "do this with my full context," subagent is for "do this with a fresh/specialized context."
- **Agent definition on fork** — should fork support an optional `agent` parameter to use a named definition (different persona but same history)? Deferred for now — forks are always "self-forks."
