# Code review: pi 0.64.0 → 0.74.0 upgrade

Scope: uncommitted changes in working tree. Authority order: installed .d.ts > pi docs > examples > changelog. Findings below ignore what `docs/plans/pi-upgrade*.md` claim and look at the actual contracts.

---

## 🔴 S1 — `session_shutdown` early-return on `reload` leaks broker + RPC children

**File:** `extensions/subagents/index.ts:1259-1265`

The handler returns immediately when `event.reason === "reload"`, intending "subagents survive `/reload`." But pi's reload flow (verified in `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1895-1913` — `agent-session.js#reload()`) does:

1. emits `session_shutdown {reason:"reload"}` — your handler no-ops.
2. calls `_buildRuntime()` which re-loads the extension via `jiti.import(..., {moduleCache:false})` (see `loader.js:286-294`). **Module-level state is recreated fresh** — the new module's `let manager = null`, `let parentBrokerClient = null`, etc. The old module's closures (still holding `Broker` server + `ChildProcess` refs) become unreachable from pi.
3. emits `session_start {reason:"reload"}` to the new instance — your handler does **not** treat `"reload"` as a skip-restore reason (S2 only skips `"new"`/`"fork"`), so it calls `mgr.restoreFromPersistence(...)`.
4. `agent-set.ts:333-348` `restoreFromPersistence` constructs a **new** Broker on a **new** socket path and **spawns new `pi` RPC child processes** for every persisted agent (`agent-set.ts:152-159, 290`).

Net result of one `/reload` with N live subagents:
- N old `pi` RPC child processes still running, orphaned, connected to the dead broker's socket file.
- 1 old broker `net.Server` still holding its listen fd until GC finalization (Unix socket file on disk also never `unlink`ed — `broker.ts:78` only runs in the explicit `stop()` path you skipped).
- 1 new broker, N new RPC child processes (the ones the user actually interacts with).

Each `/reload` doubles the process count. The comment "subagents survive `/reload`" is misleading — *persistence records* survive, but the running children are replaced (not reused), and the old ones leak.

**Evidence:**
- `agent-session.js:1895-1913` — reload flow.
- `loader.js:286-294`, `moduleCache: false` — module re-instantiation.
- `agent-set.ts:332-348` — restore unconditionally calls `start()` which builds new Broker + new RPC children.
- `broker.ts:31-80` — Broker is in-process; `stop()` is the only thing that closes the server and `unlink`s the socket file.
- `rpc-child.ts:52-58, 140` — RPC children are `spawn("pi", …)` real OS processes.

**Fix direction (don't apply — flagged for author):** either keep the full shutdown on reload, or in `restoreFromPersistence` detect that a live manager already exists in the previous module's closure (it doesn't, after `moduleCache:false`) — so the only real option is *not* to early-return. If the author wants subagents to truly survive reload, that requires architectural changes: stash the broker+rpc handles on `globalThis` keyed by parent session file and have the new module instance pick them up. The current change doesn't achieve that.

---

## 🟡 S2 — Skipping persistence restore on `"new"`/`"fork"` is fine, but interacts with S1

**File:** `extensions/subagents/index.ts:357-363`

The early-return on `event.reason === "new" || "fork"` is semantically correct: those reasons mean the session file changed, so the old session's persistence file is unrelated to the new one. `ensureManager(ctx)` is also called lazily from each tool's `execute` (lines 656, 756, 1093), so skipping the call here does not crash tools later — verified the lazy path.

The concern: when `"new"`/`"fork"` skip restore, you also skip `ensureWidget`, `ensureParentBrokerClient`, `stopSequences.addOnce`. On a brand-new session those are uninitialized anyway, so subsequent first tool call will re-initialize via `ensureManager`. ✅ verified `ensureManager` is invoked from every subagent tool execute path.

**Concern is downstream of S1**: combined with S1's reload behavior, on a `/reload` you *do* restore (S2 doesn't skip `"reload"`), which is what triggers the duplicate-spawn described above. If the author keeps S1, S2 should arguably also skip `"reload"` to avoid the duplicate spawn — but then `/reload` does nothing to subagents (no UI re-attach either). The cleanest fix is to revert S1.

---

## ✅ A1 — `ProviderConfig.name` is a real optional field

**File:** `extensions/azure-foundry/index.ts:380-389`

Verified `name?: string` on `ProviderConfig` at `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:941`. `pi.registerProvider(name, config)` signature at `types.d.ts:920` and accepts the field. Friendly-name change is safe.

---

## ✅ W1 — worktree `SessionManager` value import + signatures

**File:** `extensions/worktree/index.ts:6-7, 229, 233, 246`

Verified:
- `SessionManager` is exported as a **value** (not just a type) from package root: `dist/index.d.ts:16` re-exports `SessionManager` from `./core/session-manager.js`.
- Static method signatures match call sites:
  - `static create(cwd, sessionDir?)` → called as `SessionManager.create(cwd, sessionDir)` ✓ (`session-manager.d.ts:296`)
  - `static continueRecent(cwd, sessionDir?)` → called as `SessionManager.continueRecent(cwd, sessionDir)` ✓ (`session-manager.d.ts:309`). Returns `SessionManager` (non-nullable per .d.ts; impl at `session-manager.js:994-1001` always constructs one — `getSessionFile()` itself can return undefined when no recent session exists). The `session?.getSessionFile()` optional-chain is harmlessly defensive but redundant.
  - `static forkFrom(sourcePath, targetCwd, sessionDir?)` → called as `SessionManager.forkFrom(sourceSessionPath, targetCwd, sessionDir)` ✓ (`session-manager.d.ts:319`).
- `appendCustomEntry` and `getSessionFile` still exist on the instance.

Refactor is clean. Old `loadSessionManager()` filesystem walk was indeed unnecessary now that pi's loader bundles `@earendil-works/pi-coding-agent` (`loader.js:24`) — extensions resolve the package to the same instance.

---

## 🟢 W1 nit — unused import

**File:** `extensions/worktree/index.ts:2`

`existsSync` is imported but no longer referenced anywhere in the file (the only previous usage was inside the deleted `getPackageResolutionPaths`/`loadSessionManager`). `mkdirSync` is still used at line 155. Trim the import.

---

## ✅ TypeBox swap — `Type` and `TSchema` work at root

**Files:** `extensions/{numbered-select,user-edit,subagents}/index.ts` (`import { Type } from "typebox"`), `extensions/toolscript/index.ts` (`import type { TSchema } from "typebox"`).

Verified against installed `typebox@1.1.38`:
- `node_modules/typebox/package.json` `exports["."]` resolves to `./build/index.mjs` → `./build/index.d.mts`.
- `build/index.d.mts:6` re-exports `* as Type from './typebox.mjs'` (so `import { Type } from "typebox"` gives the Type namespace).
- `build/index.d.mts:5` does `export * from './type/types/index.mjs'` which transitively re-exports `TSchema` from `./schema.mjs`.
- All used factories (`Type.Object`, `Type.String`, `Type.Optional`, `Type.Boolean`, `Type.Array`, `Type.Integer`, `Type.Record`, `Type.Union`) are present in `build/typebox.d.mts`.
- pi's own loader pre-bundles typebox: `loader.js:18-20` — extensions get the same instance pi uses internally.

Swap is correct. The schemas in this repo only use 0.x-compatible builders that are still present in 1.x.

---

## ✅ Package rename sweep — exports still exist

Spot-checked every named import the working tree pulls from `@earendil-works/pi-coding-agent` against `dist/index.d.ts`:

| Symbol | .d.ts line |
| --- | --- |
| `ExtensionAPI`, `ExtensionCommandContext`, `ExtensionContext`, `ProviderConfig` | `index.d.ts:6` (type re-exports) |
| `SessionManager` | `index.d.ts:16` |
| `Theme` | `index.d.ts:24` |
| `withFileMutationQueue` | `index.d.ts:20` |
| `getAgentDir`, `VERSION` | `index.d.ts:1` |
| `DefaultPackageManager` | `index.d.ts:12` |
| `SettingsManager` | `index.d.ts:17` |
| `parseFrontmatter` | `index.d.ts:26` |

From `@earendil-works/pi-tui`: `Component`, `TUI`, `Input`, `Key`, `matchesKey`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`, `AutocompleteItem`, `Focusable` — all spot-checked OK in `node_modules/@earendil-works/pi-tui/dist/index.d.ts`.

From `@earendil-works/pi-ai`: only `azure-foundry` imports `streamSimple*` helpers and types — names unchanged, only scope renamed.

---

## 🟢 Style — `import type` could absorb `SessionManager`

**File:** `extensions/worktree/index.ts:6-7`

Two separate import statements from the same module. Minor; collapse:
```ts
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
```
Pure style.

---

## Things I checked and didn't flag

- `SessionStartEvent.reason` union (`types.d.ts:382-388`) confirms all 5 values used in S2 logic.
- `SessionShutdownEvent.reason` union (`types.d.ts:416-419`) confirms `"reload"` is a valid value for S1.
- `pi.on("session_start", handler)` signature accepts a handler whose first arg is `SessionStartEvent` — `event.reason` is typed, so the literal comparison is sound (`types.d.ts:785`).
- `setSessionName`/widget/panel APIs used by subagents are unchanged in surface.
- The CLI/binary in this repo is unchanged behavior-wise; just the scope rename of the dependency.

---

## Verdict

**merge after fixes.**

Mandatory before merging:
- 🔴 **S1**: resolve the broker/RPC-children process leak on `/reload`. Easiest correct fix: revert S1 (let shutdown run as before — your subagents *don't* actually survive reload today either; the persistence layer makes the new ones look like the old ones, but you pay extra processes). If preserving them across reload is genuinely wanted, that's a bigger design change.

Nice-to-have:
- 🟢 drop the unused `existsSync` import in `extensions/worktree/index.ts`.
- 🟢 collapse `worktree` SessionManager imports.

Everything else verified clean.
