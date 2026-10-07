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

- `model` — resolved through the existing tier resolution (`resolveModelRef` / `stripThinkingSuffix`, DR-038 vocabulary) and applied via `pi.setModel(...)` once at `session_start`. Bind/announce set: `startup`, `new`, `fork` (a `/new` session in the workspace must not take over silently); `resume` and `reload` do **not** rebind — the user's mid-session choice stands ("a `/model` override is never slapped back").
- `tools` — applied at `session_start` the same way (normalization shared with the child-side `resolveChildToolPolicy` semantics), same "bind once, then yield to the user" rule. In a subagent child with a workspace override, the workspace `tools` replaces the named agent's spawn-time tool policy.
- `skills` — applied per run as a filter on `options.skills`: only listed skills are declared to the model. Documented limitation (root sessions only): unlisted skills' slash commands remain loaded — extensions can add skills at discovery but not subtract them, and the ResourceLoader's skills override is unreachable from an extension (DR-029's known consequence). Child sessions keep true construction-time filtering via `skillPaths`.
- Fields absent from the front matter simply don't bind; the next level of precedence stands.

**5. Takeover notices** — transcript-visible custom messages, returned as `before_agent_start`'s `message` result (pi ingests them as `role: "custom"` messages; they render in every UI and the model sees its own mandate):

- **Boot notice** — emitted once when a persona binds a session that didn't have one (fresh `startup`/`fork`): names the persona (`name`), its source file (`sourcePath`), and — in a subagent child — the spawned agent whose definition was replaced.
- **Override notice** — emitted when a workspace declaration overrides a spawned payload: names both the spawned agent and the winning persona, so the orchestrator's belief about what it deployed is visibly corrected.
- Each notice has `customType: "persona-notice"` with a registered message renderer for clean TUI display; text content carries the same information for unrendering UIs. Notices are emitted at most once per condition per session instance; on resume the persisted transcript already contains them, so nothing re-fires.

**Default children and forks are covered by the same rules:** any session whose cwd is a persona workspace wears the persona (root sessions, default children, named children, forks that inherit the cwd per DR-034); a session whose cwd leaves the workspace leaves the persona behind.

## Tests

**Pre-test-write commit:** `7304437c39a31c371c041d23d093f8a1fbdf6d0f`

### Interface Files

- `extensions/persona-workspaces/declaration.ts` — `PersonaDeclaration` data shape plus `parsePersonaDeclaration` / `loadWorkspacePersona` signatures (bodies throw `"not implemented"`).
- `extensions/persona-workspaces/index.ts` — extension factory registering one `session_start` handler (front-matter binding), one `before_agent_start` handler (prompt binding + notices), and the `persona-notice` message renderer registration (renderer body is a stub). Handler bodies throw `"not implemented"`.
- `extensions/persona-workspaces/package.json` — pi extension manifest.
- `extensions/subagents/child-session-marker.ts` — extended: `PersonaPayload` type, optional payload parameter on `markSubagentChildSession` (existing marker semantics unchanged), `getSubagentPersona` stub that throws `"not implemented"`.

### Test Files

- `extensions/persona-workspaces/declaration.test.ts` — persona declaration parsing and strict cwd-only loading.
- `extensions/persona-workspaces/index.test.ts` — handler-level behavior via a fake pi/ctx: prompt binding, precedence, takeover notices, skills filter, session-start front-matter binding.
- `extensions/subagents/child-session-marker.test.ts` — extended with the spawn-declared persona payload surface (4 new tests).

### Behaviors Covered

#### Workspace persona declaration (`declaration.ts`)

- Parses a full `kind: persona` declaration: name, description, comma-separated `tools`, raw `model` ref (including a `:<level>` suffix), comma-separated `skills`, markdown body, and the declaring file's absolute `sourcePath`.
- The markdown below the front matter is the persona body (preamble), preserved whole.
- Optional front-matter fields stay absent when omitted.
- Content without front matter, a plain project AGENTS.md, and agent-shaped front matter without `kind: persona` are all not personas — returned as `undefined` and left entirely alone.
- Unknown `kind` values are silently ignored (never an error, never a persona); the marker match is exact (`kind: Persona` is not a persona).
- A `kind: persona` marker without a non-empty `name` yields `undefined` (see interpretation notes).
- `loadWorkspacePersona` reads only `<cwd>/AGENTS.md`: returns the declaration with `sourcePath` set; missing file → `undefined`; no ancestor walk; no subdirectory recursion; a non-persona cwd file is left alone.

#### Prompt binding (persona-workspaces `before_agent_start`)

- A workspace persona's body replaces the preamble via `systemPromptOptions.customPrompt`, every run.
- The workspace's own AGENTS.md is removed from `contextFiles` so pi cannot append it twice; other context files are kept.
- Mid-session edits to the workspace AGENTS.md take effect at the next run.
- An explicit `--system-prompt` (pre-populated `customPrompt`) outranks the directory: the persona module mutates nothing and emits nothing.
- A plain session (no workspace declaration, no spawned payload) is untouched: no prompt change, no context-file change, no skills change, no notice.
- A spawned agent's definition binds as the preamble in a subagent child without a workspace declaration.
- When both exist, the workspace declaration wins over the spawned payload; the returned notice names both the winning persona and the replaced spawned agent.

#### Takeover notices

- The boot notice is a `customType: "persona-notice"` message with `display: true`, naming the persona and its source file.
- Notices are emitted at most once per condition per session instance (the harness simulates pi ingesting the returned message into the transcript between runs).
- Fresh session instances (`startup`, `new`, `fork`) bind and announce the takeover.
- A resumed session whose transcript already contains a persona notice re-fires nothing, while prompt binding still applies on each run.

#### Skills filter (persona-workspaces `before_agent_start`)

- When the declaration lists `skills`, only the listed skills remain in `systemPromptOptions.skills`.
- When the declaration lists none, the skill list is untouched.

#### Front-matter binding (persona-workspaces `session_start`)

- The declared `model` binds once at session bind time (`startup`, `new`, `fork`) via `pi.setModel` against an available model matching the ref.
- A `:<level>` suffix on the model ref also binds the thinking level.
- A tier name resolves through the model-tiers config to the configured concrete model.
- The declared `tools` bind via `pi.setActiveTools` with exactly the normalization of `resolveChildToolPolicy({ kind: "persona", tools })` (the shared child-side semantics).
- On `resume`, neither model nor tools are rebound — the user's mid-session choice stands.
- Front matter without `model`/`tools` binds nothing.

#### Child-session persona registry (subagents)

- `getSubagentPersona` returns the payload recorded at mark time.
- Children marked without a payload and unmarked session managers yield `undefined`.
- Payloads do not leak between session managers.
- Existing marker semantics (`markSubagentChildSession` / `isSubagentChildSession`) are unchanged (pre-existing tests stay green).

### Interpretation notes (for test-review)

These tests encode judgment calls where the plan left room; flag any that misread the architecture:

1. `parsePersonaDeclaration` takes a second `sourcePath` parameter — the listed one-argument signature cannot produce the required `sourcePath` field of `PersonaDeclaration`.
2. `kind: persona` without a non-empty `name` is not a persona (`undefined`, file left alone) — `name` is required by the declared type and fabricating one invents requirements.
3. Bind/announce set: `startup`, `new`, `fork` bind and boot-announce (a `/new` session in the workspace must not take over silently). **Adjudicated:** `reload` does not rebind or announce — it behaves like `resume`. The plan's literal `reason !== "resume"` rule would have rebound and slapped back a user's `/model` override, conflicting with "a user `/model` override is never slapped back"; the anti-slap-back rule is the governing intent (confirmed by the user at architect time).
4. Tools binding reuses `resolveChildToolPolicy({ kind: "persona", tools })` exactly (drops `ask_user`, dedupes, appends `respond`) — "normalization shared with the child-side resolveChildToolPolicy semantics" read as exact reuse, root sessions included.
5. Tier-config plumbing assumptions: `model: <tier>` resolves via `loadTierConfig` (global `<agentDir>/model-tiers.json` + trusted `<cwd>/.pi/model-tiers.json`, the session-owner pattern); the resolved ref matches `ctx.modelRegistry.getAvailable()` on `id` or `provider/id` (the `/fmodel` pattern).
6. In the spawned-plus-workspace case the single `before_agent_start` `message` slot cannot carry both a boot and an override notice; tests assert only that the visible notice names both the winning persona and the replaced spawned agent.
7. No boot-notice assertion for spawned-only children: `PersonaPayload` carries no `sourcePath`, so the boot-notice text spec is workspace-shaped.

**Review status:** skipped — test-review bypassed by skip decision
