# Plan: Persona Workspaces

## Context

Let a specialist agent definition initialize the *root* session — "interactive specialist workspaces": cd into a directory, launch pi, and the session *is* the specialist from the first message — and make specialist definitions replace pi's persona everywhere, instead of stacking under it. Brainstorm: [docs/brainstorms/persona-workspaces.md](../brainstorms/persona-workspaces.md).

Verified grounding (pi `dist/core/system-prompt.js`, `dist/core/extensions/runner.js`): the preamble is fed by `systemPromptOptions.customPrompt` — a `sections.preamble` assignment would throw pi's section-name validation, so the brainstorm's "override `sections.preamble`" is corrected to "set `customPrompt`". Both `customPrompt` and `contextFiles` are handler-mutable, `before_agent_start` handlers receive a fresh normalized copy of the options per run (idempotent by construction, no cross-run accumulation), and pi renders its `project_context` block from that same mutated `contextFiles` list.

## Architecture

### Impacted Modules

**Subagents** — the spawn path stops stacking specialist bodies under the generic persona. Today `agent-set.ts` flattens `agentConfig.systemPrompt` into `ChildSessionConfig.appendSystemPrompt` (rendered as the `addendum` section); instead it passes the resolved definition as a first-class persona payload and registers it in the child-session registry at construction. The spawn path also resolves which persona file is *active* for the child (Interface 4 — a workspace declaration at the child's cwd wins wholesale) and feeds that file's `model`/`tools`/`skills` fields into the existing construction bindings (tool policy, model/tier resolution, skill paths); a discarded definition's fields never reach construction. The identity XML in the addendum is unchanged. The `subagent` tool's `agent` parameter is renamed `persona` (Terminology above). Restore/re-resurrect re-derives the payload the same way `spec.agent` is re-derived today (per DR-033), so tool gating and persona stay in step.

### New Modules

**Persona Workspaces** (`extensions/persona-workspaces/`) — owns persona resolution, prompt binding, front-matter binding, and takeover notices. One `before_agent_start` handler and one `session_start` handler; pure declaration parsing in a colocated module. Depends on Subagents' child-session registry (`extensions/subagents/child-session-marker.ts`) to read spawn-declared payloads — same cross-module consumption pattern as Autoflow Autostart's use of the marker.

### Interfaces

**Terminology.** A *persona file* is one of the distinctive-front-matter definition files the Subagents extension already discovers (`name`/`description`/`tools`/`skills`/`model` + body). After this change the same file shape can also be a working directory's `AGENTS.md` (via `kind: persona`). Persona presence is orthogonal to root-vs-subagent — all four combinations are valid (root+persona, root+plain, subagent+persona, subagent+plain). Persona sources are exclusive, in precedence order: (1) the cwd's `AGENTS.md` with `kind: persona`; (2) the spawned persona (the `subagent` tool's parameter, resolved from discovered files as today) — applies only when (1) is absent; otherwise the session has no persona. For terminology consistency the `subagent` tool's `agent` parameter is renamed `persona` (scope: tool schema plus all skill/agent-definition text that references the parameter).

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
- When both a workspace declaration and a spawned payload exist, the workspace declaration wins *wholesale* — one active agent file per session, all or nothing; the spawned definition is discarded entire, never field-merged into the winner. The override notice (below) names both. The spawned agent's addendum-side identity XML is unaffected.
- When neither exists, the handler mutates nothing — generic sessions see zero change.
- Fresh options copy per run ⇒ the handler is naturally idempotent. Mid-session edits to the workspace AGENTS.md take effect at the next run (the fog question from the brainstorm: acceptable, and the behavior is "next run", not "next session").

**4. Front-matter binding** — one active agent file per session, all or nothing. The workspace declaration wins wholesale at its cwd; with no workspace declaration the spawned definition is the active file; with neither, nothing binds. A losing definition is discarded entire — fields are never merged between the two — and fields absent from the active file fall through to pi defaults, never to the discarded file's values.

- Binding mechanics: the active file's fields bind once at session bind time (bind/announce set below). One field is construction-locked: a subagent child's skills are fixed when the SDK child session is created (`noSkills` + `skillPaths`), so the spawn path resolves the active file and feeds **its** `model`/`tools`/`skills` into the existing construction bindings for children; the discarded definition's fields must not reach construction. Root sessions have no construction machinery and bind via `pi.setModel(...)` / `pi.setActiveTools(...)`.
- **A persona's `model` field is a pin — it wins over an explicit `model` spawn argument** (existing documented semantics: "you may set `model` to override the specialist's default unless the agent definition already pins a model"). The explicit `model` argument is gap-filling only: it applies when the active persona declares no `model`, and the discarded persona's pin never applies. (This supersedes an earlier draft rule that explicit arguments beat any pin — that draft over-extended the `--system-prompt` principle, which governs launch-arg vs. ambient directory, not persona pins.)
- **An absent field is indistinguishable from no persona** for that dimension: it leaves the session's baseline untouched (root: pi's default model/tools/skills; subagent: the normal spawn baseline, e.g. the parent-inherited default model). A persona never strips baseline behavior with a field it doesn't declare.
- **Restore/resume of subagent children:** capability gates are re-derived at every construction, including restore — tools/skills gating comes from the *active* persona file resolved at restore time (workspace declaration first, else the persona name from the persistence log per DR-033). The model is not re-derived: it stays as persisted (DR-038). The "no slap-back" rule governs user-facing session state (model/thinking), never the security-relevant construction gates.
- `model` — resolved through the existing tier resolution (`resolveModelRef` / `stripThinkingSuffix`, DR-038 vocabulary). Bind/announce set: `startup`, `new`, `fork` (a `/new` session in the workspace must not take over silently); `resume` and `reload` do **not** rebind — the user's mid-session choice stands ("a `/model` override is never slapped back").
- `tools` — same "bind once, then yield to the user" rule; normalization shared with the child-side `resolveChildToolPolicy` semantics.
- `skills` — the active file's list is what the model sees (per-run filter on `options.skills`); in children it is additionally construction-locked as above. Documented limitation (root sessions only): unlisted skills' slash commands remain loaded — extensions can add skills at discovery but not subtract them, and the ResourceLoader's skills override is unreachable from an extension (DR-029's known consequence).
- A field absent from the active file binds nothing and pi's default stands.

**5. Takeover notices** — transcript-visible custom messages, returned as `before_agent_start`'s `message` result (pi ingests them as `role: "custom"` messages; they render in every UI and the model sees its own mandate):

- **Boot notice** — emitted once when a persona binds a session that didn't have one (fresh `startup`/`fork`): names the persona (`name`), its source file (`sourcePath`), and — in a subagent child — the spawned agent whose definition was replaced.
- **Override notice** — emitted when a workspace declaration overrides a spawned payload: names both the spawned agent and the winning persona, so the orchestrator's belief about what it deployed is visibly corrected.
- Each notice has `customType: "persona-notice"` with a registered message renderer for clean TUI display; text content carries the same information for unrendering UIs. Notices are emitted at most once per condition per session instance. Both boot and override notices are gated to `startup`, `new`, and `fork`; `resume` and `reload` never announce, even when a legacy transcript has no notice. The extension may retain only the latest `session_start` reason, keyed/reset for the active SessionManager, as in-memory lifecycle state; notice deduplication is reconstructed from the transcript, not a separate notice registry.

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
8. **Adjudicated after test-write (user ruling):** one active agent file per session, all or nothing — no per-field merging between a workspace declaration and a spawned definition. Tests that encode per-field fallback to the losing definition (e.g. "workspace lacks `model`, spawned agent's pin survives") are invalid against this ruling and must be adjusted to wholesale-winner semantics during implementation: absent fields fall to pi defaults.

**Review status:** skipped — test-review bypassed by skip decision

## Steps

**Pre-implementation commit:** `af13cf01998485b4f6859a0c0ec562fe89849d88`

The architecture above includes post-test-write rulings: exclusive persona sources, persona-pin model precedence (a persona `model` pin wins; an explicit `model` spawn argument is gap-filling only), and the public `persona` parameter. Those rulings govern implementation; do not preserve obsolete expectations by blending files. Tests are otherwise immutable; Interpretation note 8 identifies the narrow exception for expectations invalidated by the ruling. Do not add test-writing work to these steps.

**Implementation-time rulings (recorded during implementation):**

- (a) The draft "explicit caller arguments outrank any pin" rule is superseded (user ruling): a persona's `model` is a pin and wins over an explicit `model` spawn argument; the explicit argument is gap-filling only — it applies when the active persona declares no `model`, and a discarded persona's pin never applies. Interface 4 carries the corrected rule; Steps 3, 5, 7, 8 text updated accordingly.
- (b) `extensions/subagents/scoped-extension.integration.test.ts` ("propagates persona model, normalized tool policy, skills, and cwd to a native child") pinned the old addendum-stacking behavior (`appendSystemPrompt` contains the specialist body `"Review carefully."`) — an obsolete expectation invalidated by the architecture, since body-as-preamble replacement is this feature's core. Adjusted minimally during Step 2 to assert the body rides as the spawn-declared persona payload instead. The same test's `modelRef: "pinned/model"`-over-explicit-argument expectation is untouched and stays valid under ruling (a).
- (c) Step 1 detail deviation (Steps 4–6 implementation): `declaration.ts` parses front matter with a local pure scalar parser instead of pi's `parseFrontmatter` — the index test harness mocks `@earendil-works/pi-coding-agent` down to `getAgentDir`, so the transitive runtime import breaks there. Delimiter/body semantics mirror pi's; `declaration.test.ts` stays green.
- (d) Worker interpretations: spawned-only children emit a name-only boot notice (no fabricated `sourcePath` — interpretation note 7's implication); restores/resurrections read the persisted cwd from the lifecycle record (fallback: manager default) rather than re-parsing pi session-JSONL headers.
- (e) Step 7 compat: the public field is `persona`, but parameter reads keep a documented legacy fallback (`persona ?? agent`, plus a `renameLegacyPersonaFields` arg rewrite ahead of `dropEmptyOptionals`) so the immutable pre-existing tests' 24 `agent:` call payloads (direct `tool.execute`) and historical JSONL stay valid without migration. `persona` never leaks onto `RegularAgentSpec`; internal/persisted names remain `agent`.

### Step 1: Parse cwd persona declarations

Implement `parsePersonaDeclaration(content, sourcePath)` and `loadWorkspacePersona(cwd)` in `extensions/persona-workspaces/declaration.ts`, preserving the existing two-argument interface used by tests. Reuse pi's `parseFrontmatter` as in `extensions/subagents/agents.ts` and `extensions/model-prompt-overlays/parsing.ts`; validate the exact `kind: persona` marker and non-empty string name before returning a declaration. Preserve the markdown body, raw model reference, and supplied source path. Parse comma-separated tools/skills with whitespace trimming and empty-item removal; omit optional fields that were not supplied. Do not require a description for a workspace declaration.

The loader resolves exactly `<cwd>/AGENTS.md` to an absolute path, performs only that file read, and returns `undefined` for missing/unreadable/non-persona content. Unknown kind values remain silent. Keep parsing pure and file access in the loader.

**Verify:** `npx vitest run extensions/persona-workspaces/declaration.test.ts` passes, including strict cwd-only detection and absent-field assertions.
**Status:** done

### Step 2: Carry spawned persona payloads

Replace the symbol-keyed process-global WeakSet in `extensions/subagents/child-session-marker.ts` with `WeakMap<object, PersonaPayload | undefined>`. Implement marking with an optional payload, payload lookup, and child detection via key presence so a child without a persona remains distinguishable from a root. Preserve the existing exported functions and process-global sharing behavior.

Add optional `persona?: PersonaPayload` to `ChildSessionConfig` in `extensions/subagents/managed-child-session.ts`. In `SubagentManager.createNodeRequest` in `extensions/subagents/agent-set.ts`, pass the discovered spawned persona's `{ name, body: systemPrompt }` separately from `appendSystemPrompt`, including restored children; leave only identity XML in the append list. Retain the spawned payload even when the workspace wins so the notice can identify what the caller requested; it is not a source of winning capability fields.

Mark every SessionManager inside the managed child's `createRuntime` path before extension session-start dispatch, not only `initial.sessionManager`. This covers SDK replacement sessions as well as fresh/resumed/forked children. `CreateAgentNodeRequest.session` in `extensions/subagents/agent-session-registry.ts` already derives from `ChildSessionConfig` and its spread forwards the payload; preserve that forwarding without a second payload store. Do not persist bodies.

**Verify:** `npx vitest run extensions/subagents/child-session-marker.test.ts extensions/subagents/managed-child-session.test.ts extensions/subagents/agent-set.test.ts extensions/subagents/agent-session-registry.test.ts` passes; inspection confirms no specialist body is appended as addendum and replacement managers are marked before handlers run.
**Status:** done

### Step 3: Select the child’s active persona before binding

Update `extensions/subagents/session-owner.ts` (`spawnAgents`, `forkAgent`, `resurrectAgents`) and `extensions/subagents/agent-set.ts` (`createNodeRequest`, `toRestoreSpec`) so construction inputs derive from one active file: `loadWorkspacePersona(effectiveChildCwd)` first, otherwise the discovered spawned persona. Fresh cwd resolution continues through `resolveAgentCwds` with batch-atomic validation. Forks use the parent cwd; restores/resurrections use the opened session's persisted cwd, not the current parent's directory.

Remove the independent named-persona skill resolution in `spawnAgents`/`resurrectAgents`/`toRestoreSpec` when a workspace is active. Feed only the active file's declared skills through the existing `resolveSkillPaths` contract to the child's immutable `skillPaths`. An absent skills field leaves ordinary discovery intact; it must not retain the discarded file's list. For workspace forks, declared skills replace the fork snapshot list; absence preserves ordinary fork behavior. Preserve existing error reporting and immutable request data. Resolve workspace tools with `resolveChildToolPolicy({ kind: "persona", tools })`; absence selects the ordinary child/fork baseline rather than the discarded definition's allowlist.

For fresh children, model precedence is active file `model` (a persona pin — it wins) > explicit tool `model` (gap-filling: applies only when the active persona declares no `model`) > existing parent-inherited baseline. Validate the reference that actually wins, not a discarded pin, and retain `resolveModelRef`/`stripThinkingSuffix`, concrete provider/id canonicalization, and tier fallback diagnostics. Load trusted tier overlays for the effective child cwd; do not apply the parent's project overlay to a different workspace. Do not let the later persona handler double-bind children — construction already applied the winning reference (pin first, explicit argument as gap-fill). Workspace forks bind declared model/thinking at their fresh bind; ordinary forks retain their existing inheritance.

On restore/resurrection, re-resolve active-file tools/skills and spawned payload through the current discovery/persistence-name contract (DR-033), but omit persona-derived model/thinking overrides so the persisted model survives (DR-038). Keep the lifecycle log's existing persona-name storage readable. Do not copy active-file fields into the log or invent a second durable configuration source.

**Verify:** Existing subagent spawn, cwd, fork, restore, resurrection, tool-policy, skill-path, and model-tier tests pass with `npx vitest run extensions/subagents`. Inspect requests for a workspace with absent fields: discarded tools/skills/model never survive, an explicit caller model applies only when the winning persona declares no pin (never over a pin), and resume requests contain no re-derived model override.
**Status:** done

### Step 4: Bind persona prompts and skill declarations

Implement the single `before_agent_start` handler in `extensions/persona-workspaces/index.ts`. Resolve the workspace afresh from `ctx.cwd` on every run and obtain the spawned payload from `getSubagentPersona(ctx.sessionManager)`. Select `workspace ?? spawned` without field merging. Return immediately for no persona or pre-populated `systemPromptOptions.customPrompt`, before changing context, skills, or notices.

Set only `options.customPrompt = persona.body` for preamble replacement; never use `sections.preamble` or force the entire prompt. For a workspace, remove only its exact absolute `sourcePath` from `options.contextFiles`. For declared workspace skills, filter `options.skills` by skill name, preserving order and full resource objects; absent skills leave the list unchanged. Spawned-only skills remain the construction-filtered list from Step 3. Never reattach the losing body or treat another directory's AGENTS.md as a persona.

Keep all per-run decisions local and argument-driven. Do not cache declaration content between runs. The extension manifest already exposes `./index.ts`, and the root manifest already discovers `./extensions`; no new dependency or manifest change is required.

**Verify:** Prompt-binding and skills-filter cases in `extensions/persona-workspaces/index.test.ts` pass; successive runs observe edits, explicit custom prompts are untouched, and plain sessions produce no mutations.
**Status:** done

### Step 5: Bind root front matter at fresh session start

Implement the single `session_start` handler in `extensions/persona-workspaces/index.ts`. Bind root workspace model/tools only for `startup`, `new`, and `fork`; `resume` and `reload` do not reset user choices. Child construction owns its initial model/tools/skills from Step 3, so do not double-bind children (a child's winning model is already construction-set — pin first, explicit argument as gap-fill).

For root model binding, use `getAgentDir()`, `<agentDir>/model-tiers.json`, `<cwd>/.pi/model-tiers.json`, `ctx.isProjectTrusted()`, and `loadTierConfig`. Resolve through `resolveModelRef`, split a valid thinking suffix with `stripThinkingSuffix`, and match `ctx.modelRegistry.getAvailable()` on id or provider/id as `/fmodel` does. Apply the available model with awaited `pi.setModel`, and its explicit suffix with `pi.setThinkingLevel`; unavailable/unconfigured references leave the baseline in place and use existing tier diagnostic vocabulary. Declared tools bind using exactly `resolveChildToolPolicy({ kind: "persona", tools }).allowedTools` through `pi.setActiveTools`. Absent fields cause no setter calls.

Retain only the latest session-start reason keyed/reset for the active SessionManager as extension-instance lifecycle state, as approved in Interface 5. This state communicates bind eligibility to the prompt handler; it contains neither parsed declarations nor emitted-notice flags and is never persisted.

**Verify:** Front-matter cases in `extensions/persona-workspaces/index.test.ts` pass, including tier and thinking binding, exact tool normalization, absent fields, and no resume setter calls. Inspect reload handling and child guards for the same no-slap-back/pin-precedence rules.
**Status:** done

### Step 6: Render and deduplicate takeover notices

Complete notice generation in `extensions/persona-workspaces/index.ts` as the `before_agent_start` message result, after successful ambient prompt binding. Return one visible `customType: PERSONA_NOTICE_TYPE` message with plain text content. A workspace boot names its persona and absolute source file; a workspace overriding a spawned persona names both and the winning source. The override message occupies the single result slot rather than emitting a second boot message. Do not fabricate a sourcePath for a spawned-only payload.

Gate both boot and override announcements to fresh bind reasons (`startup`, `new`, `fork`); resumed/reloaded children still bind prompts but announce nothing. Derive once-per-condition suppression from persisted persona-notice transcript entries, including legacy entries without new details, rather than a separate mutable notice registry. Use the current branch when available for actual pi sessions and the harness's `getEntries()` interface when it is the available transcript surface. Preserve enough plain message information to identify the condition and prevent re-emission after ingestion.

Implement the registered `persona-notice` renderer using pi-tui's `Text`/`Box` pattern from `examples/extensions/message-renderer.ts`, the supplied theme/output padding, and the same informational text. Keep non-TUI behavior independent from rendering.

**Verify:** `npx vitest run extensions/persona-workspaces/index.test.ts` passes notice shape, winning/replaced names, once-per-session ingestion, fresh reasons, and resumed transcript cases. Inspect narrow-width rendering through the standard components and ensure explicit customPrompt returns before notices.
**Status:** done

### Step 7: Rename the public persona parameter and guidance

In `extensions/subagents/session-owner.ts`, rename the `subagent` tool's item schema field `agent` to `persona`, its parameter reads, validation messages, generated available-persona guidance, and descriptions. Update model-field guidance: a persona's `model` pin outranks an explicit tool `model`; the explicit argument is gap-filling only (applies when the active persona declares no `model`). Keep `agents` as the collection of child execution requests, and do not rename execution-agent IDs, lifecycle event names, or discovery directories. Map the new public field to existing internal `RegularAgentSpec.agent`/persisted `agent` storage if retaining those implementation names; historical JSONL must remain readable without migration. Remove accidental forwarding of the public `persona` field as an unrelated internal spec property.

Update `skills/orchestrating-agents/SKILL.md` and `skills/specialist-design/SKILL.md` references to the public field. In specialist-design, replace the obsolete append-system-prompt body explanation with persona preamble replacement, document cwd `kind: persona` declarations, exclusive source precedence, the four root/child × persona/plain combinations, persona-pin model precedence (pin wins; explicit `model` is gap-filling), and the root skill-slash-command limitation. Search `skills/**` (including autoflow templates), `agents/**`, and generated subagent prompts for parameter references and update any matches; do not mechanically rename ordinary uses of the word agent or historical decision records.

Update `codemap.md` with the Persona Workspaces module, its owned `extensions/persona-workspaces/**` files and registry dependency, and Subagents' payload/construction responsibility. Preserve unrelated codemap entries.

**Verify:** `rg -n 'agents\[\]\.agent|agent field|agent parameter|`agent` field' skills agents extensions/subagents/session-owner.ts` reports no obsolete public-parameter guidance. Existing discovery/persistence tests remain green, and inspection confirms the tool advertises `persona` while old persistence records still restore.
**Status:** done

### Step 8: Verify the integrated behavior

Run `npx vitest run extensions/persona-workspaces extensions/subagents` and then the repository test suite with `npx vitest run`. Do not build, compile, or type-check this repository. Resolve implementation failures against the architecture, keeping the new test files unchanged except for the explicitly adjudicated obsolete semantics in Interpretation note 8; record any such exception precisely rather than silently weakening assertions. Run `git diff --check` and review the diff for unrelated changes.

Confirm the complete data flow by inspection: the active workspace alone supplies capability declarations; the spawned payload supplies prompt fallback/override identity only; declared pins beat explicit model arguments (which fill gaps only); normal baseline survives undeclared fields; every replacement child manager is marked before handler dispatch; restored capabilities re-resolve without resetting model/thinking; fresh sessions announce once and resume/reload remain silent. Root skill filtering must not claim to unload slash commands.

**Verify:** Both targeted and full test runs pass, `git diff --check` is clean, and every implementation step above has a recorded verification result before being marked done.
**Status:** done

### Verification log

- **Step 1:** `npx vitest run extensions/persona-workspaces/declaration.test.ts` — 17/17 green, strict cwd-only detection and absent-field assertions included.
- **Step 2:** `npx vitest run extensions/subagents/{child-session-marker,managed-child-session,agent-set,agent-session-registry}.test.ts` — 44/44 green; inspection: only identity XML in the append list, every `createRuntime` manager marked before extension dispatch.
- **Step 3:** `npx vitest run extensions/subagents` — 297/297 green; transient-harness inspection (file deleted after) of six scenarios: workspace-absent fields fall to baseline, explicit model gap-fills only (pin wins), wholesale replacement with child-cwd tier overlays, resume/restoration carry no re-derived model/thinking, workspace fork binds declared model/skills. Both pre-existing pin assertions pass untouched.
- **Step 4:** prompt-binding and skills-filter cases green within `extensions/persona-workspaces/index.test.ts` (36/36 total); successive runs observe edits, explicit custom prompts untouched, plain sessions unmutated.
- **Step 5:** front-matter cases green (tier + thinking binding, exact `resolveChildToolPolicy` normalization, absent fields, no resume/reload setter calls); child double-bind guard inspected.
- **Step 6:** notice cases green (shape, winning/replaced names, once-per-session ingestion, fresh reasons, resumed transcripts); narrow-width rendering inspected at 28/40/100 columns via pi-tui `Text`/`Box`; explicit `customPrompt` returns before notices.
- **Step 7:** the step's `rg` command reports no obsolete public-parameter guidance; `npx vitest run` — 804/804 green including the immutable legacy `agent:` call sites and persistence records (compat recorded as ruling (e)).
- **Step 8:** `npx vitest run extensions/persona-workspaces extensions/subagents` — 333/333 green; `npx vitest run` — 804/804 green; `git diff --check` clean; diff reviewed — only step-scoped files plus this plan. Data-flow inspection confirmed: the active workspace alone supplies capability declarations; the spawned payload carries prompt-fallback/override identity only; pins beat explicit model arguments (gap-fill); undeclared fields fall to baseline; replacement managers are marked before handler dispatch; restored capabilities re-resolve without resetting model/thinking; fresh sessions announce once while resume/reload stay silent; root skill filtering is documented as not unloading slash commands.
