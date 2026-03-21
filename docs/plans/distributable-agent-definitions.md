# Plan: Distributable Agent Definitions

## Context

Add agent definitions (`.md` files) as a distributable component in pi packages, discoverable by the subagents extension via the `pi.agents` manifest key. Extends the existing two-source discovery (`~/.pi/agent/agents/`, `.pi/agents/`) with a third source: installed packages. See [brainstorm](../brainstorms/distributable-agent-definitions.md).

## Architecture

### Impacted Modules

#### Subagents Extension

The primary module affected. Changes span two files:

**`agents.ts`** — Agent discovery gains package awareness:
- `AgentConfig.source` widens from `"user" | "project"` to `"user" | "project" | "package:user" | "package:project"`.
- New async `discoverPackageAgents()` function: instantiates `SettingsManager` + `DefaultPackageManager`, calls `resolve()`, collects unique `baseDir` values from resource metadata (filtering to `origin: "package"`), reads `pi.agents` from each `package.json`, loads `.md` files from declared directories using the existing `loadAgentsFromDir()`. Returns `{ user: AgentConfig[], project: AgentConfig[] }` split by the package's scope.
- `discoverAgents()` stays sync but gains an optional second parameter: `packageAgents?: { user: AgentConfig[], project: AgentConfig[] }`. Merge order becomes four-tier: package:user → user-dir → package:project → project-dir (each layer's `map.set` overwrites earlier layers, so more-local wins).

**`index.ts`** — Caching and plumbing:
- Module-level `cachedPackageAgents` variable, populated in the `session_start` handler by calling `discoverPackageAgents()`. Since `session_start` re-fires on `/reload`, the cache refreshes automatically.
- Both call sites (`before_agent_start` hook and `subagent` tool `execute`) pass `cachedPackageAgents` to `discoverAgents()`.
- The project-agent trust confirmation dialog is removed entirely — no trust prompts for any source.

### Interfaces

**`discoverAgents` signature change:**
```ts
function discoverAgents(
  cwd: string,
  packageAgents?: { user: AgentConfig[], project: AgentConfig[] }
): AgentDiscoveryResult
```

**`discoverPackageAgents` (new):**
```ts
async function discoverPackageAgents(cwd: string): Promise<{ user: AgentConfig[], project: AgentConfig[] }>
```

**`AgentConfig.source` widened:**
```ts
source: "user" | "project" | "package:user" | "package:project"
```

**`pi.agents` manifest key** — array of relative paths in `package.json` under the `pi` key, following the same pattern as `extensions`, `skills`, `prompts`, `themes`:
```json
{
  "pi": {
    "agents": ["./agents"]
  }
}
```

## Steps

**Pre-implementation commit:** `31cb80612cfc295a45e966f4b153ab64309b37d4`

### Step 1: Widen `AgentConfig.source` type

In `extensions/subagents/agents.ts`, change the `source` field in the `AgentConfig` interface from `"user" | "project"` to `"user" | "project" | "package:user" | "package:project"`. Also widen the `source` parameter of `loadAgentsFromDir()` to accept the full union. These are pure type changes — no runtime behavior changes yet.

**Verify:** The file saves without syntax errors. The existing `discoverAgents()` function still works since `"user"` and `"project"` are valid values of the wider union.
**Status:** done

### Step 2: Add `discoverPackageAgents()` to `agents.ts`

Add a new exported async function to `extensions/subagents/agents.ts`:

```ts
async function discoverPackageAgents(cwd: string): Promise<{ user: AgentConfig[], project: AgentConfig[] }>
```

Implementation:
- Import `SettingsManager`, `DefaultPackageManager`, and `getAgentDir` from `@mariozechner/pi-coding-agent`.
- Instantiate `SettingsManager.create(cwd, getAgentDir())` and `new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager })`.
- Call `await pm.resolve()` to get `ResolvedPaths`.
- Collect unique `baseDir` values from all resource metadata entries where `origin === "package"`, tracking each one's `scope` (`"user"` or `"project"`).
- For each unique `baseDir`, read its `package.json`, extract `pi.agents` (array of relative directory paths), and for each directory call `loadAgentsFromDir()` with the appropriate `"package:user"` or `"package:project"` source.
- Return `{ user: [...package:user agents], project: [...package:project agents] }`.

**Verify:** Function exists and is exported. No callers yet — that's Step 4.
**Status:** done

### Step 3: Update `discoverAgents()` signature and merge logic

In `extensions/subagents/agents.ts`, add an optional second parameter to `discoverAgents()`:

```ts
function discoverAgents(
  cwd: string,
  packageAgents?: { user: AgentConfig[], project: AgentConfig[] }
): AgentDiscoveryResult
```

Change the merge order to four-tier: `package:user` → `user-dir` → `package:project` → `project-dir`. Each layer's `map.set` overwrites earlier layers, so more-local wins. When `packageAgents` is `undefined`, the behavior is identical to today (only user-dir and project-dir).

**Verify:** Without the second argument, `discoverAgents(cwd)` produces the same result as before. With package agents, they appear in the returned array with the correct `source` values, and local agents override package agents of the same name.
**Status:** done

### Step 4: Add `cachedPackageAgents` and `session_start` handler in `index.ts`

In `extensions/subagents/index.ts`, add a module-level variable `let cachedPackageAgents: { user: AgentConfig[], project: AgentConfig[] } | null = null`. Register a new `session_start` handler (outside the `if (parentLink)` block so it runs for all agents, including root) that calls `discoverPackageAgents(process.cwd())` and stores the result in `cachedPackageAgents`. Since `session_start` re-fires on `/reload`, the cache refreshes automatically.

Import `discoverPackageAgents` from `./agents.js`.

**Verify:** On session start, `cachedPackageAgents` is populated. On `/reload`, it refreshes.
**Status:** done

### Step 5: Pass `cachedPackageAgents` to both `discoverAgents()` call sites

Two call sites in `extensions/subagents/index.ts` need updating:

1. **`before_agent_start` handler** (~line 332): Change `discoverAgents(process.cwd())` to `discoverAgents(process.cwd(), cachedPackageAgents ?? undefined)`.
2. **`subagent` tool `execute`** (~line 475): Change `discoverAgents(ctx.cwd)` to `discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined)`.

**Verify:** Both call sites pass the cached package agents. Package-sourced agents appear in the discovery results when packages declare `pi.agents`.
**Status:** done

### Step 6: Remove the project-agent trust confirmation dialog

Delete the entire block in the `subagent` tool's `execute` method in `extensions/subagents/index.ts` (~lines 499–520) that checks for project agents and shows the `ctx.ui.confirm()` dialog. The architecture specifies removing trust prompts for all sources.

**Verify:** No `confirm` call remains in the subagent tool's execute method. Project-local and package-sourced agents are used without prompting.
**Status:** done

### Step 7: Manual integration test

Verify the full flow:
1. Confirm that without any packages declaring `pi.agents`, behavior is identical to before.
2. Create a test scenario: add `"agents": ["./agents"]` to an installed package's `package.json`, create an `agents/` directory with a simple `.md` agent definition, and confirm it appears in `discoverAgents()` output with `source: "package:user"` or `"package:project"`.
3. Confirm that a local user or project agent with the same name overrides the package agent.
4. Confirm that `/reload` refreshes the cached package agents.

**Verify:** All scenarios produce expected results.
**Status:** not started
