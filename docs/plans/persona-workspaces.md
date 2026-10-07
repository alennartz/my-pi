# Plan: Persona Workspaces

## Context

Let a specialist agent definition initialize the *root* session — "interactive specialist workspaces": cd into a directory, launch pi, and the session *is* the specialist from the first message — and make specialist definitions replace pi's persona everywhere, instead of stacking under it. Brainstorm: [docs/brainstorms/persona-workspaces.md](../brainstorms/persona-workspaces.md).

Verified grounding (pi `dist/core/system-prompt.js`, `dist/core/extensions/runner.js`): the preamble is fed by `systemPromptOptions.customPrompt` — a `sections.preamble` assignment would throw pi's section-name validation, so the brainstorm's "override `sections.preamble`" is corrected to "set `customPrompt`". Both `customPrompt` and `contextFiles` are handler-mutable, `before_agent_start` handlers receive a fresh normalized copy of the options per run (idempotent by construction, no cross-run accumulation), and pi renders its `project_context` block from that same mutated `contextFiles` list.

## Architecture

### Impacted Modules

**Subagents** — the spawn path stops stacking specialist bodies under the generic persona. Today `agent-set.ts` flattens `agentConfig.systemPrompt` into `ChildSessionConfig.appendSystemPrompt` (rendered as the `addendum` section); instead it passes the resolved definition as a first-class persona payload and registers it in the child-session registry at construction. Everything else on the spawn path (tool policy, model/tier resolution, skill paths, identity XML in the addendum) is unchanged. Restore/re-resurrect re-derives the payload the same way `spec.agent` is re-derived today (per DR-033), so tool gating and persona stay in step.

### New Modules

**Persona Workspaces** (`extensions/persona-workspaces/`) — owns persona resolution, prompt binding, front-matter binding, and takeover notices. One `before_agent_start` handler and one `session_start` handler; pure declaration parsing in a colocated module. Depends on Subagents' child-session registry (`extensions/subagents/child-session-marker.ts`) to read spawn-declared payloads — same cross-module consumption pattern as Autoflow Autostart's use of the marker.

### Interfaces

**1. Workspace persona declaration** (pure, `extensions/persona-workspaces/declaration.ts`):

```ts
type PersonaDeclaration = {
  kind: "persona";            // exact marker; anything else (or absent) = not a persona
  name: string;
  description?: string;
  tools?: string[];           // front matter "tools: read, bash, edit" — comma-separated
  model?: string;             // tier name or model id, DR-038 vocabulary, ":<level>" suffix allowed
  skills?: string[];          // front matter "skills:" — comma-separated
  body: string;               // markdown below front matter — becomes the preamble
  sourcePath: string;         // absolute path of the declaring AGENTS.md
};

parsePersonaDeclaration(content: string): PersonaDeclaration | undefined;
loadWorkspacePersona(cwd: string): PersonaDeclaration | undefined;
```

Detection is strict: `loadWorkspacePersona` reads `<cwd>/AGENTS.md` and nothing else — no ancestor walk, no subdirectory recursion. The persona is exactly one directory deep. A file without `kind: persona` front matter returns `undefined` and is left entirely alone (it stays project context). The `kind:` seam stays open: unknown `kind` values are reserved for future use, silently ignored (never an error, never treated as a persona), so later values can be introduced without breaking existing files.

**2. Child-session registry** (`extensions/subagents/child-session-marker.ts`, extended):

```ts
type PersonaPayload = { name: string; body: string };   // from a named agent definition

markSubagentChildSession(sessionManager: object, payload?: PersonaPayload): void;
getSubagentPersona(sessionManager: object): PersonaPayload | undefined;
isSubagentChildSession(sessionManager: object): boolean;   // unchanged semantics
```

The registry becomes a process-global `WeakMap` keyed by the child's `SessionManager` (children are in-process SDK sessions). The spawn path writes the payload where it currently discards it (`agent-set.ts` already resolves `agentConfig` by name); the persona module reads it via `ctx.sessionManager`. Deliberately not persisted — a restored/re-resurrected child is re-marked with a re-resolved payload, mirroring the existing marker contract.

**3. Prompt binding** — the persona module's `before_agent_start` handler, every run:

```ts
const workspace = loadWorkspacePersona(ctx.cwd);              // strict cwd check
const spawned = getSubagentPersona(ctx.sessionManager);       // undefined outside subagent children
const persona = workspace ?? spawned;                         // directory wins over named agent
if (!persona) return;                                         // plain session: touch nothing
if (options.customPrompt) return;   // explicit --system-prompt outranks the directory (see below)

options.customPrompt = persona.body;                          // replaces the preamble
if (workspace) {
  options.contextFiles = options.contextFiles.filter(
    (file) => file.path !== workspace.sourcePath);            // prevent pi appending it twice
}
```

- **Correction to note for implementers:** do NOT set `options.sections.preamble` — pi throws on custom sections named `preamble`. `customPrompt` is the preamble knob (pi feeds it from the loader's system-prompt override).
- **Explicit `--system-prompt` outranks the ambient persona** (brainstorm key decision: your own argument outranks the directory). A launch `--system-prompt` reaches the callback as a pre-populated `options.customPrompt`, so the guard is simply: when `customPrompt` is already set, the persona module does nothing and the session runs with the user's explicit prompt.
- When both a workspace declaration and a spawned payload exist, the workspace wins and the override notice (below) names both. The spawned agent's addendum-side identity XML is unaffected.
- When neither exists, the handler mutates nothing — generic sessions see zero change.
- Fresh options copy per run ⇒ the handler is naturally idempotent. Mid-session edits to the workspace AGENTS.md take effect at the next run (the fog question from the brainstorm: acceptable, and the behavior is "next run", not "next session").

**4. Front-matter binding** — precedence per field: workspace declaration > spawn-time binding (named agent) > pi default.

- `model` — resolved through the existing tier resolution (`resolveModelRef` / `stripThinkingSuffix`, DR-038 vocabulary) and applied via `pi.setModel(...)` once at `session_start` when `reason !== "resume"` (`startup` and `fork` bind; a resume keeps whatever the user switched to mid-session). After boot the persona stays out of the way — a user `/model` override is never slapped back.
- `tools` — applied at `session_start` the same way (normalization shared with the child-side `resolveChildToolPolicy` semantics), same "bind once, then yield to the user" rule. In a subagent child with a workspace override, the workspace `tools` replaces the named agent's spawn-time tool policy.
- `skills` — applied per run as a filter on `options.skills`: only listed skills are declared to the model. Documented limitation (root sessions only): unlisted skills' slash commands remain loaded — extensions can add skills at discovery but not subtract them, and the ResourceLoader's skills override is unreachable from an extension (DR-029's known consequence). Child sessions keep true construction-time filtering via `skillPaths`.
- Fields absent from the front matter simply don't bind; the next level of precedence stands.

**5. Takeover notices** — transcript-visible custom messages, returned as `before_agent_start`'s `message` result (pi ingests them as `role: "custom"` messages; they render in every UI and the model sees its own mandate):

- **Boot notice** — emitted once when a persona binds a session that didn't have one (fresh `startup`/`fork`): names the persona (`name`), its source file (`sourcePath`), and — in a subagent child — the spawned agent whose definition was replaced.
- **Override notice** — emitted when a workspace declaration overrides a spawned payload: names both the spawned agent and the winning persona, so the orchestrator's belief about what it deployed is visibly corrected.
- Each notice has `customType: "persona-notice"` with a registered message renderer for clean TUI display; text content carries the same information for unrendering UIs. Notices are emitted at most once per condition per session instance; on resume the persisted transcript already contains them, so nothing re-fires.

**Default children and forks are covered by the same rules:** any session whose cwd is a persona workspace wears the persona (root sessions, default children, named children, forks that inherit the cwd per DR-034); a session whose cwd leaves the workspace leaves the persona behind.
