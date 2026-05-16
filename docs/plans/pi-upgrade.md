# Pi 0.64.0 → 0.74.0 — Extension Impact Analysis

**Baseline:** `package-lock.json` resolves `@mariozechner/pi-coding-agent` to **0.64.0** (2026-03-29).
**Current runtime:** `pi --version` reports **0.74.0** (2026-05-07), installed at `/home/alenna/.nvm/.../node_modules/@earendil-works/pi-coding-agent`.

Per-extension findings live in `pi-upgrade-findings-*.md`. This file is the synthesis + action list, including parent-side verification overrides for two findings the subagents got wrong.

## Critical context: legacy package alias is preserved

Pi 0.74.0 renamed its npm scope from `@mariozechner/*` to `@earendil-works/*`. The extension loader (`dist/core/extensions/loader.js`) explicitly aliases both names to the same bundled modules:

```js
"@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
"@mariozechner/pi-coding-agent":   _bundledPiCodingAgent,
// also pi-tui, pi-ai, pi-agent-core, and @sinclair/typebox ↔ typebox
```

This means existing extension imports keep resolving with no change. Two subagents (`xref-subagents`, `xref-worktree`) flagged the rename as "must fix" — **incorrect for static imports**. The only place that genuinely breaks is code that bypasses the loader (e.g. a hand-rolled filesystem walk for the package directory — see worktree below).

---

## Per-Extension Verdicts

| Extension | Verdict | Why |
|---|---|---|
| azure-foundry | **safe** | Pure provider registration. Doesn't touch any changed API. Polish-only refactor (registerProvider `name`). |
| model-prompt-overlays | **safe** | Uses canonical `before_agent_start` return-style mutation. No changed surface. |
| numbered-select | **safe** | `pi.registerTool` shape unchanged. TypeBox 1.x import path is a cosmetic refactor. |
| session-resume | **safe** | Already uses post-0.65.0 `session_start`. Could lean on `event.reason` but current behavior is correct. |
| toolscript | **safe** | `registerTool` + tool result shape unchanged. MCP/typebox surfaces untouched. |
| subagents | **safe** + refactor | Loader alias resolves all imports. The actual `pi.sendUserMessage` / `pi.sendMessage` / `setWidget` / `registerTool` calls all keep working. Multiple worthwhile refactors below. |
| **worktree** | **must fix** | Hand-rolled `loadSessionManager()` filesystem walk bypasses the loader alias. Currently resolves to the stale 0.64.0 copy in local `node_modules/@mariozechner/pi-coding-agent`, not the 0.74.0 runtime. Sessions are being written with a 10-release-old `SessionManager`. |

---

## Must-Fix

### W1 · worktree — replace `loadSessionManager()` walk with a value import

**File:** `extensions/worktree/index.ts:1–65`.

**Current code:**

```ts
import { createRequire, globalPaths } from "node:module";
import type { …, SessionManager as SessionManagerType } from "@mariozechner/pi-coding-agent";

const require = createRequire(import.meta.url);
let cachedSessionManager: typeof SessionManagerType | undefined;

function getPackageResolutionPaths(): string[] { /* walks NODE_PATH, npm root -g, process.cwd, etc. */ }

function loadSessionManager(): typeof SessionManagerType {
  if (cachedSessionManager) return cachedSessionManager;
  for (const packageRoot of getPackageResolutionPaths()) {
    if (!existsSync(join(packageRoot, "package.json"))) continue;
    try { cachedSessionManager = require(packageRoot).SessionManager as …; return cachedSessionManager; }
    catch { continue; }
  }
  throw new Error("Could not resolve @mariozechner/pi-coding-agent for worktree session management");
}
```

**Why it breaks now:** The global pi install no longer ships `@mariozechner/pi-coding-agent` — only `@earendil-works/pi-coding-agent`. The walk falls through to `process.cwd()/node_modules/@mariozechner/pi-coding-agent`, which still exists at version 0.64.0 because `package-lock.json` was generated against that baseline. So worktree silently uses a 10-release-old `SessionManager` to read/write session files alongside a 0.74.0 pi runtime — anything format-related (entry shape changes, fork-position semantics from 0.68.0, etc.) is at risk.

**Fix:**

```ts
import { SessionManager } from "@mariozechner/pi-coding-agent";
// (or @earendil-works/pi-coding-agent — both aliased to the same bundled module)
```

Delete `getPackageResolutionPaths`, `loadSessionManager`, `cachedSessionManager`, and the `createRequire`/`globalPaths` imports. Replace every `loadSessionManager()` call site (index.ts:159, 162, 169) with `SessionManager`.

**Stale-ctx footgun (0.69.0) verified safe:** worktree calls `ctx.switchSession(sessionFile)` at index.ts:110 inside `controller.create`. Trace shows the handler returns immediately after, and the only post-switch work is pure `fs.rm` in `sessions.discard` — no `ctx`/`pi` reuse. Not affected by the 0.69.0 stale-ctx invalidation.

---

## Refactor Opportunities (Non-Breaking)

Ordered roughly by expected payoff.

### S1 · subagents — branch on `session_shutdown.reason` to survive `/reload`

**File:** `extensions/subagents/index.ts:1203`.

0.68.0 added `event.reason` (`"quit" | "reload" | "new" | "resume" | "fork"`) and `targetSessionFile`. Currently the handler tears down all subagents on every `session_shutdown` — including `/reload`, which is annoying when iterating on the extension itself. Skipping teardown on `"reload"` keeps subagents alive across reloads.

Sketch:
```ts
pi.on("session_shutdown", async (event, ctx) => {
  if (event.reason === "reload") return;
  await manager.teardownAll();
});
```

### S2 · subagents — branch on `session_start.reason` to skip persistence restore on `new`/`fork`

**File:** `extensions/subagents/index.ts:381`.

0.65.0 added `event.reason` (`"startup" | "reload" | "new" | "resume" | "fork"`) and `previousSessionFile`. Persistence restore only makes sense on `"startup"` and `"resume"`. Currently the extension probably re-checks the session entry stream every time.

### S3 · all extensions using `@sinclair/typebox` — switch to `typebox` (cosmetic)

Pi 0.69.0 migrated to TypeBox 1.x. The legacy `@sinclair/typebox` import is still aliased, but new code should use `typebox`. Affected: `numbered-select/index.ts:2`, `subagents/index.ts:16`, `toolscript/index.ts:2`, `user-edit/index.ts:3`. Zero runtime impact, just hygiene.

Note: `@sinclair/typebox/compiler` is **not** aliased in 0.74.0 (only `/compile` and `/value`). None of the extensions use `/compiler`, so this isn't an issue today — but flag it if subagents ever needs schema compilation.

### A1 · azure-foundry — add top-level `name` to each `registerProvider` call (polish)

**File:** `extensions/azure-foundry/index.ts:297`.

0.71.0 added a top-level `name` field that controls how the provider appears in `/login`. Currently the three providers show as their raw IDs (`azure-foundry-anthropic-messages`, etc.).

```ts
pi.registerProvider("azure-foundry-anthropic-messages", {
  name: "Azure Foundry (Anthropic Messages)",
  baseUrl, apiKey, api, models, streamSimple,
});
```

### A2 · azure-foundry — populate `thinkingLevelMap` on reasoning-capable models (optional)

0.72.0 replaced `compat.reasoningEffortMap` with model-level `thinkingLevelMap`. Azure Foundry never used the old field, so there's nothing to migrate — but for models with `reasoning: true`, an explicit `thinkingLevelMap` would let pi expose only the levels each Azure model actually supports, hiding unsupported levels from the `/thinking` cycle.

### W2 · worktree — consider `withSession` callback pattern (optional)

0.69.0 introduced `ctx.switchSession(file, { withSession })` so post-switch work can run against the new session's `ReplacedSessionContext`. Today worktree doesn't need this (it returns immediately after `switchSession`), but if future logic ever wants to send a message or append an entry on the new session, `withSession` is the right path — don't reuse the old `ctx`.

### Subagents R-tier observations (low value, listed for completeness)

- `RpcClient` is now exported from the package root (0.67.67). subagents rolls its own RPC framer, so this doesn't apply.
- `terminate: true` on tool results (0.69.0) could in principle let `await_agents` / `respond` end the tool batch without an extra LLM turn, but the current tool flow already cooperates correctly. Not worth refactoring.
- `renderShell: "self"` (0.67.3) doesn't fit subagent tools — they don't render large stable previews.

---

## Verification Notes

- **Loader alias evidence:** `/home/alenna/.nvm/versions/node/v25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js` defines `VIRTUAL_MODULES` with both `@earendil-works/*` and `@mariozechner/*` entries pointing to the same bundled modules.
- **Stale local node_modules:** `/home/alenna/repos/my-pi/node_modules/@mariozechner/pi-coding-agent/package.json` reports `"version": "0.64.0"`. The 0.74.0 runtime lives only at `/home/alenna/.nvm/.../node_modules/@earendil-works/pi-coding-agent/package.json`.
- **Worktree walk confirmed broken:** With `@mariozechner/pi-coding-agent` removed from global node_modules and only present at the stale local 0.64.0 copy, `loadSessionManager()` resolves to 0.64.0 — silently divergent from the rest of the runtime.

---

## Recommended Order of Operations

1. **W1** (worktree must-fix) — single-PR change, removes a real divergent-version bug.
2. **S1 + S2** (subagents quality-of-life on reload + new/fork) — small, high payoff.
3. After (1), refresh `package-lock.json` against `@earendil-works/pi-coding-agent` to align peer-dep resolution.
4. **A1, S3** (cosmetic polish) — batch into a single hygiene PR whenever convenient.
5. **A2, W2** — defer until there's a reason.

## Out-of-Scope Risks Not Covered

The changelog only documents what pi *changed* — APIs that the extensions use but the changelog never mentions still need a spot-check. Specifically:
- `ctx.ui.editor()`, `ctx.ui.select()`, `ctx.ui.notify()`, `ctx.ui.setWidget()`, `ctx.ui.custom()` signatures.
- `withFileMutationQueue` signature.
- `ctx.sessionManager.getBranch / getEntries / getSessionFile / appendCustomEntry / getSessionDir` signatures.
- `pi.appendEntry(customType, data)` shape (entry-type discriminator strings at `session-resume/index.ts:9–11` are the fragile spot).
- `pi.sendUserMessage`, `pi.sendMessage({triggerTurn})` option shape.
- `Model<Api>` and `SimpleStreamOptions` shapes from `@mariozechner/pi-ai`.

Easiest mitigation: after the W1 fix and an aligned lockfile, do a single smoke run of each extension (open a session, exercise its primary path) and watch for runtime errors. None are likely — these are all stable surfaces — but the changelog can't promise that.
