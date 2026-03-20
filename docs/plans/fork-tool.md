# Plan: Fork Tool

## Context

Add a `fork` tool to the subagents extension that lets an agent clone itself into a sub-agent with its full conversation history. The clone explores independently while the primary self continues working — a powerful paradigm for divergent exploration without committing context. Built as syntactic sugar over a single-agent group using existing GroupManager infrastructure. See [brainstorm](../brainstorms/fork-tool.md).

## Architecture

### Impacted Modules

**Subagents Extension (`extensions/subagents/`)**

The main impact zone. Changes span three areas:

1. **All subagents get session files.** Replace `--no-session` with `--session-dir <tempdir>` in `buildAgentArgs()`. `GroupManager` creates a temp directory via `mkdtemp` at group start and passes it to every child. This removes the asymmetry where only some agents could be forked. `GroupManager.destroy()` recursively removes the temp directory after stopping all processes.

2. **Fork-aware agent specs.** The agent spec becomes a discriminated union (`kind: "agent" | "fork"`). `RegularAgentSpec` covers existing subagent behavior. `ForkAgentSpec` carries the parent's session file, filtered active tools, skill paths, and thinking level. `GroupManager.start()` branches on `kind` to call either `buildAgentArgs()` or a new `buildForkArgs()`.

3. **New `fork` tool registration.** A new tool in `index.ts` with a single `task` parameter. It snapshots the parent's live state, constructs a `ForkAgentSpec`, and feeds it through the existing group creation path. Prompt guidelines on both `fork` and `subagent` are updated so the LLM understands when to use each.

### Interfaces

**Agent spec discriminated union** (consumed by `GroupManager`):

```ts
interface RegularAgentSpec {
  kind: "agent";
  id: string;
  agent?: string;
  task: string;
  channels?: string[];
}

interface ForkAgentSpec {
  kind: "fork";
  id: string;
  task: string;
  sessionFile: string;
  tools: string[];
  skillPaths: string[];
  thinkingLevel: string;
}

type AgentSpec = RegularAgentSpec | ForkAgentSpec;
```

**`buildForkArgs(spec: ForkAgentSpec, sessionDir: string): string[]`** (in `agents.ts`):

Builds CLI args for a forked child: `--fork <sessionFile>`, `--session-dir <sessionDir>`, `--thinking <level>`, and conditionally `--tools` (only when the parent has a restricted built-in subset — omitted when all built-ins are active, matching current subagent behavior). Skill args via `--no-skills` + `--skill <path>` per skill.

**Parent state gathering** (in `fork` tool execute):

- Session file: `ctx.sessionManager.getSessionFile()` — error if undefined
- Tools: `pi.getActiveTools()` intersected with built-in set (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Full set → omit arg.
- Skills: `pi.getCommands()` filtered by `source === "skill"` → paths
- Thinking level: `pi.getThinkingLevel()`

**Temp session directory lifecycle** (in `GroupManager`):

- Created via `fs.mkdtemp(path.join(os.tmpdir(), 'pi-subagents-'))` in `start()`
- Passed as `--session-dir` to all children (both regular and fork)
- Recursively removed in `destroy()` after all processes stop

**Prompt guidelines update:**

- `fork` tool: framed as cloning yourself to explore an alternative idea or path with your full context, while your primary self continues working. One parameter: `task`.
- `subagent` tool: updated to acknowledge fork's existence — steer toward subagent when the work needs multiple coordinated agents, specialized personas, or a clean slate; toward fork when you want a copy of yourself to explore something.

**Identity injection:** Fork gets `--append-system-prompt` with identity XML and `PI_PARENT_LINK` env var, same as regular subagents. Single-agent group topology: channels are `["parent"]` only.

**Session file cleanup on fork teardown:** Handled automatically by the temp directory cleanup — the forked session file lives in the same temp dir as all other subagent sessions.
