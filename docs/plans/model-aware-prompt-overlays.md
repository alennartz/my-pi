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

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

## Steps

**Pre-implementation commit:** `9fcb75a606d9e793a26bed8a9dc73a06e4339535`

### Step 1: Create extension scaffold and context root discovery

Create the extension directory `extensions/model-prompt-overlays/` with:

- `package.json` — minimal manifest with `"pi": { "extensions": ["./index.ts"] }`
- `discovery.ts` — exports `discoverContextRoots(cwd: string, agentDir: string): ContextRoot[]` and the `ContextRoot` type
- `index.ts` — skeleton extension that imports from `@mariozechner/pi-coding-agent` and registers a `before_agent_start` handler that does nothing yet (returns `undefined`)

`discoverContextRoots` mirrors pi's `loadProjectContextFiles` from `dist/core/resource-loader.js`:

1. Check `agentDir` for `AGENTS.md` or `CLAUDE.md` (in that priority order). If found, emit a root with `scope: "global"`.
2. Walk from filesystem root up to `cwd`, collecting directories that contain `AGENTS.md` or `CLAUDE.md`. Store farthest-first, closest-last. Each gets `scope: "ancestor"`.
3. Return global root (if any) followed by ancestor roots. Each `ContextRoot` includes `dir`, `baseFilePath` (absolute path to the selected base file), and `scope`.

Use `fs.existsSync` for detection, same as pi does. Use `path.resolve` for the ancestor walk.

```ts
type ContextRoot = {
  dir: string;
  baseFilePath: string;
  scope: "global" | "ancestor";
};
```

Write a companion test file `discovery.test.ts` using vitest. Tests should use `fs.mkdtempSync` to create temp directory trees with various `AGENTS.md` / `CLAUDE.md` placements and verify:
- Global root is included first when present
- Ancestor walk returns farthest → nearest order
- `AGENTS.md` is preferred over `CLAUDE.md` when both exist
- Directories with neither file are skipped
- `cwd` itself is included when it has a context file

**Verify:** `npx vitest run extensions/model-prompt-overlays/discovery.test.ts` passes.
**Status:** done

### Step 2: Overlay file loading and parsing

Create `extensions/model-prompt-overlays/parsing.ts` exporting `loadOverlayFiles(root: ContextRoot)` and the `OverlayFile` / `OverlayDiagnostic` types.

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

Behavior:
1. Read directory entries of `root.dir` using `fs.readdirSync`.
2. Filter to files matching `AGENTS.*.md` (case-sensitive). Exclude `AGENTS.md` itself (no dot-segment).
3. For each matching file, read its content and parse frontmatter using `parseFrontmatter` from `@mariozechner/pi-coding-agent`.
4. Validate the `models` field:
   - Must exist and be either a string or a non-empty array of strings.
   - Normalize a single string `"claude-*"` to `["claude-*"]`.
   - If missing, not a string/array, or empty array → push a diagnostic and skip the file.
5. `body` is the post-frontmatter content (from `parseFrontmatter`'s `.body`).
6. Return overlays sorted alphabetically by filename for deterministic output.

Write `parsing.test.ts` with temp directories containing various overlay files:
- Valid single-glob overlay
- Valid multi-glob overlay
- Missing `models:` field → diagnostic
- Empty `models: []` → diagnostic
- `models:` is a number → diagnostic
- File named `AGENTS.md` (base file) is excluded
- Non-matching filenames like `README.md` or `CLAUDE.md` are excluded
- Body text after frontmatter is captured correctly

**Verify:** `npx vitest run extensions/model-prompt-overlays/parsing.test.ts` passes.
**Status:** done

### Step 3: Model matching with glob specificity

Create `extensions/model-prompt-overlays/matching.ts` exporting `matchOverlay(modelId: string, overlay: OverlayFile)` and the `MatchResult` type.

```ts
type MatchResult = {
  matched: true;
  matchingGlob: string;
  literalChars: number;
  wildcardCount: number;
};

function matchOverlay(
  modelId: string,
  overlay: OverlayFile
): MatchResult | { matched: false };
```

Also export a helper `globToRegex(glob: string): RegExp` (or keep it internal) and a comparator `compareSpecificity(a: MatchResult, b: MatchResult): number` for sorting broad → narrow.

Glob semantics:
- `*` matches zero or more characters (any character except nothing special — model IDs don't contain path separators so simple `.*` replacement works).
- The glob must match the entire model ID (anchor `^...$`).
- Escape regex-special characters in the literal parts of the glob.

Specificity computation per matching glob:
- `literalChars` = number of non-`*` characters in the glob string
- `wildcardCount` = number of `*` characters in the glob string

When multiple globs in one overlay match, pick the **most specific** one (highest `literalChars`, then lowest `wildcardCount`) — this becomes the overlay's sorting specificity.

Comparator for broad → narrow ordering:
1. Ascending `literalChars` (fewer literal chars = broader)
2. Descending `wildcardCount` (more wildcards = broader)
3. Ascending `path` (stable tie-breaker)

Write `matching.test.ts`:
- `claude-*` matches `claude-sonnet-4-5` → matched with literalChars=6, wildcardCount=1
- `claude-sonnet-*` matches `claude-sonnet-4-5` → literalChars=14, wildcardCount=1
- `claude-sonnet-4-5` matches exactly → literalChars=17, wildcardCount=0
- `gpt-*` does NOT match `claude-sonnet-4-5`
- Multi-glob overlay `["claude-*", "claude-sonnet-*"]` matching `claude-sonnet-4-5` → picks `claude-sonnet-*` as the most specific
- Specificity comparator sorts `[claude-sonnet-4-5, claude-*, claude-sonnet-*]` into `[claude-*, claude-sonnet-*, claude-sonnet-4-5]`
- Glob with special regex chars (e.g., `o3-*`) works correctly
- Glob `*` matches any model ID (broadest possible)

**Verify:** `npx vitest run extensions/model-prompt-overlays/matching.test.ts` passes.
**Status:** done

### Step 4: Prompt block rendering

Create `extensions/model-prompt-overlays/rendering.ts` exporting `renderOverlayAppendBlock(matches: MatchedOverlay[]): string | undefined`.

```ts
type MatchedOverlay = OverlayFile & MatchResult;
```

Behavior:
- Returns `undefined` when `matches` is empty.
- Produces a single Markdown block with the heading `# Model-Specific Prompt Overlays`, followed by one `## /absolute/path/to/AGENTS.foo.md` sub-section per overlay, with the overlay body as content.
- The overlay body is included as-is (already stripped of frontmatter by `loadOverlayFiles`).
- Trim trailing whitespace from each body, ensure a single blank line between sections.

Expected output shape:
```
# Model-Specific Prompt Overlays

## /home/user/.pi/agent/AGENTS.claude.md

[body text]

## /home/user/project/AGENTS.claude-sonnet.md

[body text]
```

Write `rendering.test.ts`:
- Empty matches → `undefined`
- Single overlay → correct heading + section
- Multiple overlays → sections in input order (caller is responsible for sorting)
- Body whitespace is trimmed at the end

**Verify:** `npx vitest run extensions/model-prompt-overlays/rendering.test.ts` passes.
**Status:** done

### Step 5: Session-local diagnostics deduplication

Create `extensions/model-prompt-overlays/diagnostics.ts` exporting `createDiagnosticsTracker()` which returns an object with a `shouldNotify(path: string, message: string): boolean` method.

```ts
function createDiagnosticsTracker(): {
  shouldNotify(path: string, message: string): boolean;
};
```

Behavior:
- Maintains a `Set<string>` keyed by `"${path}:${message}"`.
- Returns `true` on first occurrence of a given path+message pair, `false` on subsequent calls.
- The tracker is created once per extension load (session-local lifetime).

This is simple enough that a small set of inline tests in `diagnostics.test.ts` suffices:
- First call for a path+message → `true`
- Second identical call → `false`
- Different message for same path → `true`
- Different path for same message → `true`

**Verify:** `npx vitest run extensions/model-prompt-overlays/diagnostics.test.ts` passes.
**Status:** done

### Step 6: Wire up the main extension hook

Complete `extensions/model-prompt-overlays/index.ts` to tie all modules together in the `before_agent_start` handler.

The extension default export receives `pi: ExtensionAPI` and:
1. Creates a diagnostics tracker (session-local, lives for the extension's lifetime).
2. Registers a `before_agent_start` handler `(event, ctx)`:
   a. Read `ctx.model?.id`. If no model, return `undefined` (no overlay).
   b. Call `discoverContextRoots(ctx.cwd, getAgentDir())` to get ordered roots.
   c. For each root, call `loadOverlayFiles(root)`. Collect all overlays and diagnostics.
   d. For each diagnostic, if `tracker.shouldNotify(path, message)` is `true`, call `ctx.ui.notify(message, "warning")`.
   e. For each overlay, call `matchOverlay(ctx.model.id, overlay)`. Collect matched overlays.
   f. Sort matched overlays: preserve root order (global first, then far → near ancestors), then within each root sort broad → narrow by specificity comparator, with path as final tie-breaker.
   g. Call `renderOverlayAppendBlock(sortedMatches)`. If it returns a string, return `{ systemPrompt: event.systemPrompt + "\n\n" + block }`.
   h. Otherwise return `undefined`.

Imports:
- `getAgentDir`, `parseFrontmatter` from `"@mariozechner/pi-coding-agent"`
- `ExtensionAPI` type from `"@mariozechner/pi-coding-agent"`
- Internal modules: `discoverContextRoots`, `loadOverlayFiles`, `matchOverlay`, `renderOverlayAppendBlock`, `createDiagnosticsTracker`

The sorting in step (f) should be implemented as a standalone exported function `sortMatchedOverlays(matches: Array<MatchedOverlay & { rootIndex: number }>): MatchedOverlay[]` in `matching.ts` so it can be unit-tested. Each matched overlay gets tagged with its `rootIndex` (the index of its root in the `discoverContextRoots` output) before sorting.

Add sorting tests to `matching.test.ts`:
- Overlays from earlier roots sort before later roots
- Within same root, broad overlays sort before narrow
- Tie-breaker: alphabetical path

**Verify:** All tests pass: `npx vitest run extensions/model-prompt-overlays/`. Manual smoke test: create `~/.pi/agent/AGENTS.claude.md` with `models: ["claude-*"]` frontmatter and some body text, start a pi session with a Claude model, and confirm the overlay text appears at the end of the system prompt (inspect via `/context` or similar).
**Status:** done
