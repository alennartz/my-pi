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
