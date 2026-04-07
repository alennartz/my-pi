# Plan: Model-Aware Prompt Overlays

## Context

Build a standalone pi extension that appends model-specific prompt overlays on top of the normal context-file prompt stack. The goal is to keep shared conventions in `AGENTS.md` while allowing model-tuned guidance for model IDs such as `claude-*`, `gpt-*`, or `o3-*` without duplicating the full prompt. See `docs/brainstorms/model-aware-prompt-overlays.md`.

## Architecture

### Impacted Modules

No existing codemap module changes its runtime responsibilities. This is an additive extension: `Workflow`, `Subagents`, `Session Resume`, `Worktree`, and `Azure Foundry` remain behaviorally unchanged.

The only repo-level impact is that the package gains a new standalone extension module that pi can load like the existing standalone extensions.

### New Modules

### Model Prompt Overlays

A new standalone extension module under `extensions/model-prompt-overlays/` owns model-aware prompt layering.

**Purpose**
- Add append-only, model-specific prompt overlays to pi sessions
- Mirror pi's existing context-file discovery roots closely enough to feel native
- Keep the feature reusable and independent of workflow/subagent logic

**Responsibilities**
- Discover the same filesystem roots pi uses for context files: global agent dir plus the cwd ancestor walk
- Reproduce pi's per-directory base-file selection rule (`AGENTS.md` first, `CLAUDE.md` second) so overlay roots line up with the directories that actually contribute base context
- Scan each discovered root for sibling overlay files matching `AGENTS.*.md`
- Parse overlay frontmatter, normalize `models:` globs, and ignore malformed files
- Match overlays against `ctx.model.id` on each prompt
- Order matching overlays deterministically by root order, then broad → narrow specificity within each root
- Append one clean overlay block to the effective system prompt in a pi-like path-labeled format
- Emit subtle, deduplicated warnings for malformed overlay files without breaking prompt assembly

**Dependencies**
- pi extension hooks: `before_agent_start`
- pi exports: `getAgentDir`, `parseFrontmatter`
- Node filesystem/path utilities

**Approximate location**
- `extensions/model-prompt-overlays/index.ts`
- Helper modules adjacent to it for discovery, parsing/matching, and rendering
- Tests adjacent to the extension module

### Interfaces

The extension should be organized around a few small internal boundaries so the matching and ordering logic can be tested without needing a full pi session.

#### Context root discovery

```ts
type ContextRoot = {
  dir: string;
  baseFilePath: string; // AGENTS.md or CLAUDE.md actually selected for this dir
  scope: "global" | "ancestor";
};

function discoverContextRoots(cwd: string, agentDir: string): ContextRoot[];
```

**Contract**
- Mirrors `DefaultResourceLoader`'s context-file walk order:
  1. global agent dir first, if it contains `AGENTS.md` or `CLAUDE.md`
  2. then ancestor directories from farthest → nearest, including `cwd`
- Uses pi's candidate order per directory: `AGENTS.md` first, `CLAUDE.md` second
- Returns only directories that actually contribute a base context file
- Does **not** attempt package-level context discovery, because pi does not load `AGENTS.md` from packages today

This is the root-order source of truth for overlay ordering.

#### Overlay file parsing

```ts
type OverlayFile = {
  path: string;
  dir: string;
  body: string;
  models: string[];
};

type OverlayDiagnostic = {
  path: string;
  message: string;
};

function loadOverlayFiles(root: ContextRoot): {
  overlays: OverlayFile[];
  diagnostics: OverlayDiagnostic[];
};
```

**Contract**
- Scans only sibling files matching `AGENTS.*.md`
- Excludes the base `AGENTS.md` file itself
- Parses frontmatter with `parseFrontmatter`
- Requires a `models:` field
- Normalizes `models:` to a non-empty `string[]`
- Accepts one or more model globs per file
- Invalid files are ignored and surfaced as diagnostics rather than throwing

The file body after frontmatter stripping is the prompt text appended later.

#### Model matching and specificity

```ts
type MatchResult = {
  matched: true;
  matchingGlob: string;
  literalChars: number;
  wildcardCount: number;
};

function matchOverlay(modelId: string, overlay: OverlayFile): MatchResult | { matched: false };
```

**Contract**
- Matches on `ctx.model.id` only
- Uses simple glob semantics appropriate for model IDs, with `*` as the supported wildcard
- If multiple globs in one file match, the file's ordering specificity is computed from the **most specific matching glob**
- Narrower means: more literal characters, then fewer wildcards
- Sorting is broad → narrow within a root, so broader overlays appear earlier and narrower overlays appear later
- Final tie-breakers should be stable and deterministic (path/name)

Example ordering for model `claude-sonnet-4-5`:
1. `claude-*`
2. `claude-sonnet-*`
3. `claude-sonnet-4-5`

#### Prompt block rendering

```ts
type MatchedOverlay = OverlayFile & MatchResult;

function renderOverlayAppendBlock(matches: MatchedOverlay[]): string | undefined;
```

**Contract**
- Returns `undefined` when there is no active model or no matching overlays
- Produces one appended block for the whole prompt, not prompt surgery into existing `# Project Context`
- Uses pi-like path labeling so the prompt remains inspectable

Expected shape:

```md
# Model-Specific Prompt Overlays

## /absolute/path/to/AGENTS.claude.md

[overlay body]

## /absolute/path/to/AGENTS.claude-sonnet.md

[overlay body]
```

This intentionally preserves deterministic layering while accepting the SDK/runtime limitation that an extension can only append/replace the completed prompt at `before_agent_start`.

#### Session-local diagnostics dedupe

```ts
function shouldNotifyDiagnostic(path: string, message: string): boolean;
```

**Contract**
- Prevent repeated `notify()` spam when the same malformed overlay is encountered on multiple prompts
- Session-local dedupe is sufficient for v1
- Diagnostics are informational only; they never block prompt construction

### Runtime behavior

On every `before_agent_start`:
1. Read `ctx.model?.id`
2. Rediscover context roots
3. Load and validate sibling overlays per root
4. Match overlays for the current model
5. Sort by:
   - discovered root order (global, then far → near ancestors)
   - broad → narrow specificity within that root
   - stable path tie-breaker
6. Render one append block and return `event.systemPrompt + "\n\n" + block`

This means model changes affect subsequent prompts automatically. There is no sticky overlay state to clean up: the next prompt simply recomputes overlays for the newly selected model.

### Constraints and limitations

- The extension mirrors pi's default filesystem discovery; it cannot inspect a custom SDK `ResourceLoader` or `agentsFilesOverride()` state from inside `before_agent_start`
- Exact per-scope adjacency inside pi's built `# Project Context` section is not available through the extension API, so v1 uses a single appended overlay block instead
- Package-level context roots are out of scope because pi does not currently discover `AGENTS.md` from packages
- Silent-by-default UX means no routine model-change or match notices in the UI
