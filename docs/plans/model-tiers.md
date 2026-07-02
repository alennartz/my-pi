# Plan: Model Intelligence Tiers

## Context

Add named model-intelligence tiers (`cheap`, `medium`, `smart`, `frontier`) to the subagents extension: tier names become the advertised vocabulary for the `subagent` tool's `model` field and agent-definition pins, resolved to concrete model IDs from a JSON config at spawn time. The always-injected Available Models list is replaced by a four-row tier table, with a new `list_models` tool for on-demand catalog discovery. See `docs/brainstorms/model-tiers.md`.

## Architecture

### Impacted Modules

- **Subagents** (`extensions/subagents/`) — gains tier config loading and tier-aware model resolution; the system-prompt injection block and spawn-path validation/resolution change; a new `list_models` tool is registered. No changes to lifecycle, channels, persistence, fork, or resurrect (resurrect keeps the concrete model per the brainstorm; `fork` has no model parameter).

### New Modules

None. One new file inside the Subagents module: `extensions/subagents/model-tiers.ts` with colocated `model-tiers.test.ts`, following the module's pure-function-plus-test convention (cf. `channels.ts`, `session-snapshot.ts`).

### Interfaces

**`extensions/subagents/model-tiers.ts`** — pure functions, no I/O in resolution logic:

```ts
export const TIER_NAMES = ["cheap", "medium", "smart", "frontier"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** Flat tier→model-id map; any subset of tiers may be configured. */
export type TierConfig = Partial<Record<TierName, string>>;

export function isTierName(ref: string): ref is TierName;

/**
 * Read global config then overlay project config.
 * - globalPath: <agentDir>/model-tiers.json (agentDir = ~/.pi/agent)
 * - projectPath: <cwd>/<CONFIG_DIR_NAME>/model-tiers.json, honored only when projectTrusted
 * Missing files, unparseable JSON, non-string values, and unknown keys are
 * tolerated: bad entries are dropped, never thrown. Returns {} at worst.
 */
export function loadTierConfig(opts: {
  globalPath: string;
  projectPath: string;
  projectTrusted: boolean;
}): TierConfig;

/**
 * Resolution result for a `model` field value (tool override or agent pin).
 * - ref is a tier name, tier configured and model available   → { model: <configured id> }
 * - ref is a tier name, unconfigured or model unavailable     → { model: undefined, warning? }
 *   (undefined = no --model override; child uses session default)
 * - ref is not a tier name                                    → { model: ref } (passthrough,
 *   existing isValidModelRef validation applies unchanged)
 * `warning` is present only for a configured tier whose model is not in
 * availableModelRefs (an id or provider/id set derived from the registry).
 * The entirely-unconfigured case (empty TierConfig) is not a per-call warning:
 * the integration layer emits one session-level notice — see below.
 */
export function resolveModelRef(
  ref: string,
  tiers: TierConfig,
  isAvailable: (ref: string) => boolean,
): { model: string | undefined; warning?: string };

/**
 * Render the tier table lines for system-prompt injection. Each configured
 * tier shows its resolved model id; unconfigured/unavailable tiers show the
 * concrete session-default model id with a "(default)" marker, so transcripts
 * always record which model a tier-named spawn actually used. Pure — returns
 * string[].
 */
export function renderTierTable(
  tiers: TierConfig,
  isAvailable: (ref: string) => boolean,
  defaultModelRef: string,
): string[];
```

**Integration contract in `index.ts`:**

- **Validation loop** (`execute`, around `isValidModelRef`): tier names are always valid values for `a.model`. Non-tier values validate exactly as today. The unknown-model error message lists the four tier names before the model preview.
- **Spec mapping** (`rawModel = agentConfig?.model ?? a.model`): `rawModel` passes through `resolveModelRef` before the existing `availableModels.find` provider/id resolution. This single insertion covers both tool overrides and agent-definition pins. A returned `warning` is surfaced once per session via `ctx.ui.notify` (per-session dedup set, same pattern as model-prompt-overlays diagnostics). Additionally, when `loadTierConfig` yields an empty config (no file found anywhere), a single session-level notice is emitted — "model tiers unconfigured; all tiers use the session default model" — once, not per tier and not per spawn.
- **Prompt injection** (`before_agent_start`): the `## Available Models` block is removed and replaced by a `## Model Tiers` block built from `renderTierTable`, plus guidance: pick the tier matching the task; raw model IDs also accepted when the user names one; `list_models` shows the full catalog. Config is read fresh on each injection and each spawn (files are tiny; edits apply without `/reload`).

**`list_models` tool** (registered in `index.ts`, gated by `shouldRegisterTool`):

```ts
// parameters: none
// result: one text block — a table of all ctx.modelRegistry.getAvailable()
// entries sorted by provider/id, with columns:
//   provider/id | context window | input $/Mtok | output $/Mtok | cacheRead $/Mtok
// description notes it complements the tier table for cases where a
// concrete model is explicitly required.
```

Tool description and a `promptSnippet` one-liner; no `promptGuidelines` needed beyond the tier-table guidance.

### DR Notes

No supersessions. DR-033 (resurrect re-resolves persona from persistence log) is consistent with resurrect retaining the concrete model — tiers resolve once at spawn and are never re-resolved.

## Tests

**Pre-test-write commit:** `6f41dea0af065072727dba5793bdc9514286d220`

### Interface Files

- `extensions/subagents/model-tiers.ts` — tier vocabulary (`TIER_NAMES`, `TierName`, `TierConfig`) and stub signatures for `isTierName`, `loadTierConfig`, `resolveModelRef`, and `renderTierTable` (bodies throw "not implemented"). No existing files needed changes — integration into `index.ts` (validation loop, spec mapping, prompt injection, `list_models` tool) is implementation work.

### Test Files

- `extensions/subagents/model-tiers.test.ts` — behavioral tests for the four pure/config functions: tier-name recognition, config loading and overlay semantics, model-ref resolution, and tier-table rendering. Uses temp-dir fixtures for `loadTierConfig`, following the module's existing test conventions (`persistence.test.ts`, `cwd.test.ts`).

### Behaviors Covered

#### isTierName

- Recognizes exactly the four tier names `cheap`, `medium`, `smart`, `frontier`
- Rejects concrete model ids, arbitrary strings, the empty string, and case variants (case-sensitive)

#### loadTierConfig

- Returns `{}` when neither config file exists
- Loads tiers from global-only and project-only configs
- Overlays project entries on global entries per key (project wins; unshadowed global keys survive)
- Ignores the project config entirely when the project is untrusted
- Tolerates unparseable JSON in either or both files without throwing — the other file still applies; worst case is `{}`
- Drops non-string values and unknown tier keys while keeping valid entries from the same file
- Tolerates a non-object JSON top level

#### resolveModelRef

- Configured tier with an available model resolves to the configured id, no warning
- Unconfigured tier (including entirely-empty config) resolves to `undefined` with no warning — child falls back to the session default
- Configured tier whose model is unavailable resolves to `undefined` with a warning naming the unavailable model
- Non-tier refs pass through unchanged with no warning, even when unavailable — existing `isValidModelRef` validation stays the caller's job
- Availability is consulted with the configured model id

#### renderTierTable

- Emits a row for every tier name
- Configured, available tiers show their configured model id without a `(default)` marker
- Unconfigured tiers show the session-default model id with a `(default)` marker
- Configured-but-unavailable tiers show the session default with `(default)` and omit the unavailable id
- Mixed configs render configured and defaulted rows distinguishably

**Review status:** skipped — test-review bypassed by skip decision

## Steps

### Step 1: Implement `isTierName`

In `extensions/subagents/model-tiers.ts`, replace the `isTierName` stub body: return true iff `ref` is one of `TIER_NAMES` (exact, case-sensitive match — `(TIER_NAMES as readonly string[]).includes(ref)`).

**Verify:** `npx vitest run extensions/subagents/model-tiers.test.ts -t isTierName` — all 4 tests pass.
**Status:** not started

### Step 2: Implement `loadTierConfig`

In `extensions/subagents/model-tiers.ts`, replace the `loadTierConfig` stub body. Behavior:

- Read `globalPath` first, then `projectPath` (only when `opts.projectTrusted`), overlaying project keys over global keys.
- Per file: `fs.readFileSync` + `JSON.parse` wrapped so any error (missing file, unparseable JSON) yields an empty contribution from that file — the other file still applies. Never throw.
- From a parsed value: if the top level is not a plain object, contribute nothing. Otherwise keep only entries whose key is in `TIER_NAMES` and whose value is a string; drop everything else (bad entries in a file do not invalidate its good entries).
- Worst case returns `{}`.

Suggested shape: a small pure helper `sanitize(parsed: unknown): TierConfig` plus a read-one-file wrapper, merged with spread (`{ ...global, ...project }`).

**Verify:** `npx vitest run extensions/subagents/model-tiers.test.ts -t loadTierConfig` — all 10 tests pass.
**Status:** not started

### Step 3: Implement `resolveModelRef`

In `extensions/subagents/model-tiers.ts`, replace the `resolveModelRef` stub body per the documented contract:

- Non-tier `ref` → `{ model: ref }` (passthrough, no availability check, no warning).
- Tier `ref`, unconfigured in `tiers` → `{ model: undefined }` (no warning).
- Tier `ref`, configured, `isAvailable(configuredId)` true → `{ model: configuredId }`.
- Tier `ref`, configured, unavailable → `{ model: undefined, warning }` where the warning string names the unavailable model id (tests assert `warning` contains the configured id).

**Verify:** `npx vitest run extensions/subagents/model-tiers.test.ts -t resolveModelRef` — all 8 tests pass.
**Status:** not started

### Step 4: Implement `renderTierTable`

In `extensions/subagents/model-tiers.ts`, replace the `renderTierTable` stub body. Emit one line per tier in `TIER_NAMES` order (plus any header lines you like — tests only assert content):

- Configured and available: line contains the tier name and the configured model id, and does NOT contain `(default)`.
- Unconfigured, or configured-but-unavailable: line contains the tier name, `defaultModelRef`, and the literal marker `(default)`; the unavailable configured id must NOT appear anywhere in the output.
- Each tier's name and its model must share a single line (the mixed-config test finds lines via `l.includes("cheap")` etc.), so keep any header row free of tier names.

Format suggestion: markdown table rows `| cheap | \`gpt-5.4-mini\` |` / `| frontier | \`gpt-5.4\` (default) |`.

**Verify:** `npx vitest run extensions/subagents/model-tiers.test.ts` — entire file passes (all 27 tests).
**Status:** not started

### Step 5: Tier config loading + notify-dedup plumbing in `index.ts`

In `extensions/subagents/index.ts`:

1. Import `getAgentDir` and `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent` (both are exported — `getAgentDir()` returns `~/.pi/agent`), `path` from `node:path`, and `loadTierConfig`, `resolveModelRef`, `renderTierTable`, `isTierName` from `./model-tiers.js`.
2. Inside the extension function, add a helper that reads config fresh on every call (no caching — edits apply without `/reload`):

```ts
function loadTiers(cwd: string, projectTrusted: boolean): TierConfig {
    return loadTierConfig({
        globalPath: path.join(getAgentDir(), "model-tiers.json"),
        projectPath: path.join(cwd, CONFIG_DIR_NAME, "model-tiers.json"),
        projectTrusted,
    });
}
```

   Both the tool-execute ctx and the `before_agent_start` ctx expose `ctx.cwd` and `ctx.isProjectTrusted()` (same `ExtensionContext`; cf. `extensions/model-prompt-overlays/index.ts`).
3. Add a per-session dedup set for tier notices, following the model-prompt-overlays diagnostics pattern (`extensions/model-prompt-overlays/diagnostics.ts`): a module-closure `Set<string>` keyed by message, plus a `notifyTierIssueOnce(ctx, message)` helper that calls `ctx.ui.notify(message, "warning")` only for unseen messages.

**Verify:** helpers exist and compile mentally against real exports; used by Steps 6–8. No behavior change yet.
**Status:** not started

### Step 6: Tier names accepted in spawn validation

In the `subagent` tool's `execute` in `extensions/subagents/index.ts`, in the per-agent validation loop (`if (a.model) { ... isValidModelRef ... }`):

- A tier name is always a valid `a.model` value: change the condition to skip the throw when `isTierName(a.model)`.
- In the unknown-model error message, list the four tier names before the model preview, e.g. `Unknown model "..." for agent "...". Tiers: cheap, medium, smart, frontier. Available models: ...`.
- Update the `AgentItem` `model` field description to advertise tiers as the primary vocabulary: tier name (`cheap`, `medium`, `smart`, `frontier`) or a concrete model id; ignored when the specialist definition pins a model.

**Verify:** spawning `{ model: "smart" }` does not throw at validation even with no tier config; spawning `{ model: "nonsense" }` throws with tier names listed in the message.
**Status:** not started

### Step 7: Tier resolution in the spec-mapping path

In the `subagent` tool's `execute`, in the `agentSpecs` mapping (`const rawModel = agentConfig?.model ?? a.model`):

1. Load tiers once per execute call: `const tiers = loadTiers(ctx.cwd, ctx.isProjectTrusted())`.
2. When `rawModel` is defined, pass it through `resolveModelRef(rawModel, tiers, isValidModelRef)` before the existing `availableModels.find` provider/id resolution; use the returned `model` (which may be `undefined` — no `--model` override, child uses the session default). This single insertion covers both tool overrides and agent-definition pins.
3. Surface a returned `warning` via `notifyTierIssueOnce(ctx, warning)`.
4. Empty-config notice: when `tiers` is empty (`Object.keys(tiers).length === 0`) and at least one spec's `rawModel` is a tier name, call `notifyTierIssueOnce` with `"model tiers unconfigured; all tiers use the session default model"` — once per session (dedup), not per tier and not per spawn.

**Verify:** with a global `~/.pi/agent/model-tiers.json` (or a project `.pi/model-tiers.json` in a trusted dir) mapping `cheap` to a real model, spawning `{ model: "cheap" }` launches the child with that model (visible in the dashboard/`check_status` model field); with no config, `{ model: "cheap" }` spawns on the session default and a single unconfigured notice appears.
**Status:** not started

### Step 8: Replace the Available Models prompt block with the tier table

In the `before_agent_start` handler in `extensions/subagents/index.ts`:

1. Delete the `modelIds` computation and the whole `## Available Models` block (and its early-return participation: keep injecting whenever the `subagent` tool is active, even when `agents.length === 0`).
2. Build an availability predicate from `ctx.modelRegistry.getAvailable()` — same id-or-`provider/id` matching as `isValidModelRef` in execute.
3. Read config fresh via `loadTiers(ctx.cwd, ctx.isProjectTrusted())` and render a `## Model Tiers` block from `renderTierTable(tiers, isAvailable, defaultModelRef)`, where `defaultModelRef` is `ctx.model?.id ?? "session default"` (the `before_agent_start` ctx exposes `model`).
4. Follow the table with guidance lines: pick the tier matching the task's difficulty; raw model IDs are also accepted in `agents[].model` when the user names a specific model; `list_models` shows the full catalog. Keep the existing trailing guidance about the default agent and pinned models, but replace "Do not set a custom `model`..." with tier-oriented phrasing (tiers are the advertised vocabulary; omit `model` when the default is fine).

**Verify:** start a session in this repo, run any prompt, and inspect the system prompt (e.g. via session file or `/debug`): `## Available Models` is gone, `## Model Tiers` shows four rows with `(default)` markers for unconfigured tiers.
**Status:** not started

### Step 9: Register the `list_models` tool

In `extensions/subagents/index.ts`, add a new tool registration gated by `shouldRegisterTool("list_models")`:

- `name: "list_models"`, `label: "List Models"`, `parameters: Type.Object({})` (no parameters).
- Description notes it complements the tier table for cases where a concrete model is explicitly required; add a `promptSnippet` one-liner to the same effect (the `promptSnippet?: string` field exists on tool definitions). No `promptGuidelines`.
- `execute`: read `ctx.modelRegistry.getAvailable()`, sort by `provider/id`, and return one text block — a table with columns `provider/id | context window | input $/Mtok | output $/Mtok | cacheRead $/Mtok`. Model entries carry `provider`, `id`, `contextWindow: number`, and `cost: { input, output, cacheRead, cacheWrite }` (per-Mtok dollar figures from pi-ai's `Model` type).

**Verify:** in a live session, calling `list_models` returns the sorted table with pricing columns; a child spawned with a `tools` restriction that omits `list_models` does not get the tool.
**Status:** not started

### Step 10: Full test suite

Run the repo test suite to confirm nothing regressed: `npx vitest run`.

**Verify:** all test files pass, including the pre-existing `extensions/subagents/*.test.ts` suites.
**Status:** not started
