# Distributable Agent Definitions

## The Idea

Add agent definitions (`.md` files used by the subagents extension) as a distributable component in pi packages — alongside skills, extensions, prompts, and themes. Entirely extension-level; no upstream pi-core changes.

## Key Decisions

### Extension-level, not pi-core
Agent definitions aren't a first-class pi resource type. The subagents extension handles discovery and loading. Rationale: avoids upstream changes for a feature only relevant when the subagents extension is active.

### Manifest annotation via `pi.agents`
Packages declare agent directories in `package.json` under the `pi` key (e.g., `"agents": ["./agents"]`), same pattern as skills/extensions/prompts/themes. Pi-core ignores unknown keys, so this is safe. The subagents extension reads the key when scanning packages.

### Discovery via PackageManager (public API)
The extension instantiates `SettingsManager` + `DefaultPackageManager` (both exported from `@mariozechner/pi-coding-agent`), calls `resolve()`, extracts unique package root directories from `baseDir` in path metadata, then reads each `package.json` for the `pi.agents` key. This gives complete coverage of all installed packages — npm, git, and local — without reimplementing path resolution.

### Cached at session start
Package discovery runs once at `session_start` and caches the results. The `resolve()` call is async and does real filesystem/npm work, so it shouldn't repeat every turn. User-dir and project-dir scanning remain per-call (cheap `readdirSync`).

### Override priority follows existing layering
Project-dir agents (`.pi/agents/`) > user-dir agents (`~/.pi/agent/agents/`) > package agents. Within packages, project-scoped packages win over global-scoped (inherited from pi's existing package deduplication). Same-name collisions resolve by picking the more-local source.

### New source tag: `"package"`
Agent definitions from packages get `source: "package"` (currently only `"user" | "project"`), so they display distinctly in the available agents list.

### Missing skills are a no-op
If an agent definition references a skill that isn't installed, the agent still works — it just doesn't get that skill. No dependency resolution machinery needed.

## Direction

Extend `discoverAgents()` in the subagents extension with a third discovery source: installed pi packages. At session start, use the public `SettingsManager`/`DefaultPackageManager` APIs to resolve all installed packages, find their root directories, read `pi.agents` from their manifests, and load agent `.md` files from the declared paths. Cache the results for the session lifetime. Tag these agents as `source: "package"` and layer them below user and project agents in override priority.

## Open Questions

- Should package filtering (the object form in settings with glob patterns) apply to the `agents` key? Pi-core wouldn't handle this since it doesn't know about the key — the extension would need to implement filtering itself if desired. Likely not worth it initially.
- How should `/reload` interact with cached package agents? Re-running discovery on reload would be consistent with how pi reloads other resources, but adds complexity.
