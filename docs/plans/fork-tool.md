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

## Steps

**Pre-implementation commit:** `793ea33276da804b3c8fe64225b628c7ed7bcc55`

### Step 1: Define `AgentSpec` discriminated union in `agents.ts`

Add and export `RegularAgentSpec`, `ForkAgentSpec`, and `AgentSpec` types below the existing `AgentConfig` interface in `extensions/subagents/agents.ts`:

```ts
export interface RegularAgentSpec {
  kind: "agent";
  id: string;
  agent?: string;
  task: string;
  channels?: string[];
}

export interface ForkAgentSpec {
  kind: "fork";
  id: string;
  task: string;
  sessionFile: string;
  tools: string[];
  skillPaths: string[];
  thinkingLevel: string;
}

export type AgentSpec = RegularAgentSpec | ForkAgentSpec;
```

`RegularAgentSpec` mirrors the existing inline type used in `GroupManagerOptions.agents`. `ForkAgentSpec` carries everything needed to spawn a forked child.

**Verify:** All three types are exported from `agents.ts`. `RegularAgentSpec` fields match the shape currently used in `GroupManagerOptions`.
**Status:** done

### Step 2: Update `buildAgentArgs()` to accept `sessionDir`

In `extensions/subagents/agents.ts`, change the signature of `buildAgentArgs()` from `(agent: AgentConfig | undefined, skillPaths: string[])` to `(agent: AgentConfig | undefined, skillPaths: string[], sessionDir: string)`. Replace the `--no-session` push with `--session-dir`, `sessionDir`. This makes all subagents write session files into a shared temp directory instead of being ephemeral — required because `--fork` and `--no-session` are mutually exclusive, and this removes the asymmetry so any agent could potentially be forked.

The only caller is `GroupManager.start()` in `group.ts`, which will pass the temp dir (Step 4).

**Verify:** `buildAgentArgs()` no longer emits `--no-session`. It emits `["--session-dir", sessionDir]` as its first args. The function signature includes the new third parameter `sessionDir: string`.
**Status:** done

### Step 3: Add `buildForkArgs()` in `agents.ts`

Add and export `buildForkArgs(spec: ForkAgentSpec, sessionDir: string): string[]` below `buildAgentArgs()` in `extensions/subagents/agents.ts`. It builds CLI args for a forked child:

- `--fork`, `spec.sessionFile` — branch from the parent's session
- `--session-dir`, `sessionDir` — write the fork's session into the shared temp dir
- `--thinking`, `spec.thinkingLevel` — preserve parent's thinking level
- If `spec.tools.length > 0`: `--tools`, `spec.tools.join(",")` — only when the parent has a restricted built-in subset. An empty array means "all defaults — omit the flag" (matching current subagent behavior where omitting `--tools` gives all built-ins).
- `--no-skills` plus `--skill <path>` per entry in `spec.skillPaths` — same pattern as `buildAgentArgs()`. If `skillPaths` is empty, omit both flags.

**Verify:** `buildForkArgs` is exported. A spec with `tools: ["read", "bash"]`, `skillPaths: ["/path/to/skill"]`, `thinkingLevel: "high"` produces args including `--fork`, `--session-dir`, `--thinking high`, `--tools read,bash`, `--no-skills`, `--skill /path/to/skill`. Empty `tools` array omits `--tools`. Empty `skillPaths` omits `--no-skills` and `--skill`.
**Status:** done

### Step 4: Update `GroupManager` for temp dir lifecycle and fork-aware spawning

Four changes in `extensions/subagents/group.ts`:

**4a — Import changes.** Import `ForkAgentSpec`, `AgentSpec`, `buildForkArgs` from `./agents.js` alongside the existing `AgentConfig` and `buildAgentArgs` imports. Add `import * as fs from "node:fs"` and `import * as os from "node:os"` for temp dir management.

**4b — Update `GroupManagerOptions.agents`.** Change the `agents` field type from `Array<{ id: string; agent?: string; task: string; channels?: string[] }>` to `AgentSpec[]`.

**4c — Temp dir lifecycle.** Add a `private sessionDir: string | null = null` field to `GroupManager`. In `start()`, before the broker starts, create the temp directory via `fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-'))` and store it in `this.sessionDir`. In `destroy()`, after stopping all processes and the broker, recursively remove the temp directory with `fs.rmSync(this.sessionDir, { recursive: true, force: true })`.

**4d — Fork-aware agent spawning.** In `start()`, where we iterate over agents to build args, branch on the spec's `kind`:

- `kind === "agent"` (RegularAgentSpec): current behavior — look up `AgentConfig`, resolve skill paths, call `buildAgentArgs(agentConfig, agentSkillPaths, this.sessionDir!)`. Channels from `agentSpec.channels ?? []`.
- `kind === "fork"` (ForkAgentSpec): skip agent config lookup, skip skill path resolution (already resolved in the spec), call `buildForkArgs(agentSpec, this.sessionDir!)`. No `agentConfig.systemPrompt` append (fork inherits from session). Identity XML and `PI_PARENT_LINK` still appended (same as regular agents). Channels hardcoded to `[]` (only "parent" after the auto-inject).

The `agentDef` field on `AgentStatus` is left undefined for forks. The `task` and `id` are read from the spec directly (both spec kinds have these fields).

**Verify:** `GroupManager` creates a temp directory in `start()` and passes it to arg-building functions. `destroy()` cleans up the temp directory. A `ForkAgentSpec` results in `buildForkArgs()` being called with no agent config system prompt appended. A `RegularAgentSpec` results in `buildAgentArgs()` being called. No `--no-session` appears anywhere.
**Status:** done

### Step 5: Update subagent tool to use `RegularAgentSpec`

In `extensions/subagents/index.ts`:

1. Import `RegularAgentSpec` and `AgentSpec` from `./agents.js`.
2. In the subagent tool's `execute()`, map `params.agents` to `RegularAgentSpec[]` by adding `kind: "agent" as const` to each entry before passing to `GroupManager`:
   ```ts
   const agentSpecs: RegularAgentSpec[] = params.agents.map(a => ({
     kind: "agent" as const,
     ...a,
   }));
   ```
3. Pass `agentSpecs` (instead of `params.agents`) to the `GroupManager` constructor's `agents` field.
4. Update the subagent tool's `promptGuidelines` to add a line: `"Use subagent when the work needs multiple coordinated agents, specialized personas, or a clean slate. Use fork when you want a copy of yourself with your full context to explore something."`.

**Verify:** The subagent tool constructs `RegularAgentSpec` objects with `kind: "agent"`. The `GroupManager` receives properly typed `AgentSpec[]`. Subagent prompt guidelines mention fork as an alternative.
**Status:** done

### Step 6: Register the fork tool

Add a new `pi.registerTool()` call in `extensions/subagents/index.ts` for the `fork` tool with a single `task` parameter (string, description: "Task description for the forked clone").

The `execute()` function:

1. **Guard:** If `activeGroup` exists, throw `"A group is already active. Call teardown_group first."` — same error as subagent tool (fork creates a single-agent group).
2. **Gather parent state:**
   - Session file: `ctx.sessionManager.getSessionFile()` — throw `"Cannot fork: no active session file"` if undefined.
   - Tools: `pi.getActiveTools()` filtered to the built-in set (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). If the filtered list contains all 7, pass an empty array (meaning "all defaults — omit `--tools`"). If fewer, pass the filtered list.
   - Skills: `pi.getCommands()` filtered by `cmd.source === "skill"` and `cmd.path` is truthy, mapped to `cmd.path!`.
   - Thinking level: `pi.getThinkingLevel()` as string.
3. **Construct spec:** Build a `ForkAgentSpec` with `kind: "fork"`, `id: "fork"`, the task, session file, tools, skill paths, and thinking level.
4. **Build topology and group:** Single-element `agents` array. Topology via `buildTopology([{ id: "fork", channels: [] }])`. No `validateTopology` needed (single agent, trivial). No agent config lookup, no skill resolution, no project agent confirmation.
5. **Create `GroupManager`** with the same callback pattern as the subagent tool: `onUpdate` (dashboard), `onGroupIdle`, `onAgentComplete`, `onParentMessage`, `resolveContextWindow`. Widget setup identical — dashboard creation gated on `!parentLink`.
6. **Start and connect:** `group.start()` → connect `parentBrokerClient` to broker, same as subagent tool.
7. **Return** the start acknowledgment text.

Prompt guidelines for fork:
- `"Clones yourself into a sub-agent with your full conversation history. The clone explores independently while you continue working — use for divergent exploration without committing context."`
- `"One parameter: task. Use fork when you want a copy of yourself with full context to explore an alternative path. Use subagent for multiple agents, specialized personas, or a clean slate."`
- `"One active group at a time. Fork creates a single-agent group — send, respond, check_status, and teardown_group all work normally. Notifications arrive the same way (<agent_complete>, <group_idle>)."`

Factor out the shared group-creation logic (widget setup, GroupManager callbacks, broker client connection) into a helper function to avoid duplicating it between the subagent and fork tools.

**Verify:** The fork tool is registered with name `"fork"`, label `"Fork"`, a single `task` parameter, and prompt guidelines. It gathers session file, tools, skills, and thinking level from the parent's live state. It constructs a `ForkAgentSpec`, creates a single-agent group via `GroupManager`, and returns an acknowledgment. Error thrown when no session file or group already active.
**Status:** not started
