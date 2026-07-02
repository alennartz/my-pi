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
