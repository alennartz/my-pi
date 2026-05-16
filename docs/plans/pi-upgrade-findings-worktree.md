# Worktree extension — pi 0.64.0 → 0.74.0 findings

## Surfaces touched and classifications

### ❌ Breaking: runtime `require()` lookup of `@mariozechner/pi-coding-agent` package directory

**Location:** `extensions/worktree/index.ts:21–65` — `loadSessionManager()` and `getPackageResolutionPaths()`.

**Mechanism:** The extension intentionally avoids the static value import of `SessionManager` (it only imports the *type*) and instead walks a list of candidate filesystem roots (`process.cwd()`, `globalPaths`, `NODE_PATH`, `<execPrefix>/lib/node_modules`, `npm root -g`), appending `@mariozechner/pi-coding-agent` and `node_modules/@mariozechner/pi-coding-agent` to each, then `require()`s the first one that has a `package.json`. If none are found it throws `"Could not resolve @mariozechner/pi-coding-agent for worktree session management"`.

**Why it now fails:** changelog **0.74.0** renames the npm package to `@earendil-works/pi-coding-agent`. On the current install the global `@mariozechner` directory is empty:

```
/home/alenna/.nvm/.../@earendil-works/pi-coding-agent/   ← v0.74.0 lives here
/home/alenna/.nvm/.../@mariozechner/                     ← empty
```

None of the candidate roots will contain a `@mariozechner/pi-coding-agent/package.json`. `loadSessionManager()` throws the first time the user runs `/worktree create` or `/worktree cleanup` (any path that calls `sessions.continueRecent / create / forkFrom`).

**Note about static imports working:** the loader (`core/extensions/loader.ts` in 0.74.0) supplies *both* `@earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` as jiti aliases / virtualModules, so the existing `import type { ... } from "@mariozechner/pi-coding-agent"` at index.ts:7 still resolves at type-check time and a *value* import would resolve at runtime. The breakage is specifically the extension’s hand-rolled filesystem walk, which bypasses jiti and looks at real disk paths.

**Migration sketch (no patch, prose only):**
- Replace the entire `getPackageResolutionPaths` + `loadSessionManager` + `cachedSessionManager` machinery with a plain value import: `import { SessionManager } from "@mariozechner/pi-coding-agent"` (or update the import to `@earendil-works/pi-coding-agent` — the loader aliases both, but the new scope is the forward-compatible choice). Then `SessionManager.continueRecent(...)` etc. work directly inside `createDependencies()`.
- Drop the `cachedSessionManager` cache, the `npm root -g` shell-out, and the `createRequire` import.
- If the original motivation for filesystem `require()` was to dodge a bundler that didn’t understand the package, that motivation no longer applies under jiti virtualModules — extensions are loaded as TypeScript and any aliased import resolves.

This is the only true must-fix in the extension.

---

### ✅ Unaffected: `ctx.switchSession(sessionFile)` legacy signature (0.65.0 + 0.69.0)

**Location:** `index.ts:127` (the `runtime.switchSession` wrapper in `createDependencies`) — invoked from `controller.ts:75, 124, 175`.

**Why the changelog made me look:** 0.69.0 says “Session-replacement commands now invalidate captured pre-replacement `pi` / `ctx` references after `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`… Stale references now THROW.”

**Signature today (`0.74.0` types):**
```ts
switchSession(sessionPath: string, options?: {
  withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}): Promise<{ cancelled: boolean }>;
```
The positional-only call `ctx.switchSession(sessionFile)` is still valid (the options bag is optional), and returns `{ cancelled }` exactly as the controller already expects (`controller.ts:177 — if (!switchResult.cancelled)`).

**Stale-ctx audit (the actual 0.69.0 risk):** I traced both control flows that reach `runtime.switchSession`:

1. **`controller.create`** — three terminal call sites (`controller.ts:75, 123`). Each is the last statement of its branch; the function `return`s immediately afterward. No `ctx.*`, `pi.*`, or `runtime.*` (which closes over `ctx`) is touched post-switch.

2. **`controller.cleanup`** — `runtime.switchSession(sessionFile)` at `controller.ts:175`. The only post-switch work is `await sessions.discard(sourceSessionFile)` (controller.ts:179), which is `await rm(sessionFile, { force: true })` — a pure `fs` call defined in `index.ts:181–186`. It does not read `ctx`, `pi`, or any session-bound state. The captured `switchResult` is just the return value of the switch promise, not a reuse of `ctx`.

3. **Event handlers and the `sendUserMessageAndAwaitTurn` machinery** in `index.ts:128–164`: they capture `pi` from the extension factory, but in `cleanup` they fire **before** `switchSession` (the agent merge instruction is sent + awaited *first*, then the switch happens last). There is no post-switch path that touches the captured `pi`.

Conclusion: the stale-ctx footgun does not bite this extension. No `withSession` migration is required for correctness today.

---

### ⚠️ Refactor opportunity: optionally adopt `withSession` for `cleanup`’s discard

Even though `sessions.discard` is pure `fs.rm` and therefore stale-ctx-safe, the changelog (0.69.0 + 0.70.0) is explicit that post-switch work *should* live in a `withSession` callback. Moving the discard there future-proofs against the day someone needs to do anything `ctx`-bound after the switch (e.g. emit a notification on success, fork the new session, etc.). Sketch:

```
await runtime.switchSession(sessionFile, async (replacedCtx) => {
  // pure fs cleanup, but now it’s structurally in the right place
  await sessions.discard(sourceSessionFile);
  // future: replacedCtx.ui.notify("worktree merged and cleaned up", "info");
});
```

This requires plumbing the `options` arg through `WorktreeRuntime.switchSession`. Pure ergonomics; not required for 0.74.0 to work.

---

### ✅ Unaffected: events subscribed

`pi.on("agent_start", …)` and `pi.on("agent_end", …)` (index.ts:137, 142). Neither is touched by the 0.65.0 removal of `session_switch` / `session_fork`. The extension does **not** subscribe to either of the removed events.

---

### ✅ Unaffected: `session_directory` field removed (0.65.0)

The removal was of a *field* on event/settings payloads. The worktree extension reads `ctx.sessionManager.getSessionDir()` (index.ts:126), which is a **method** on `SessionManager` and is still present in `ReadonlySessionManager` (verified in `dist/core/session-manager.d.ts:189` of 0.74.0). Same for `getSessionFile()` (index.ts:127, `dist/core/session-manager.d.ts:191`).

---

### ✅ Unaffected: `SessionManager.{continueRecent,create,forkFrom}` and `appendCustomEntry` signatures

All four signatures in 0.74.0 (`dist/core/session-manager.d.ts:296, 309, 319, 208`) match the call sites in `index.ts:159, 162, 169, 168`:

- `SessionManager.continueRecent(cwd, sessionDir?)` → unchanged
- `SessionManager.create(cwd, sessionDir?)` → unchanged
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` → unchanged
- `manager.appendCustomEntry(customType, data?)` → unchanged
- `manager.getSessionFile()` → unchanged

No changelog entry between 0.65.0 and 0.74.0 touches these.

---

### ✅ Unaffected: `pi.registerCommand`

Still the public hook for slash commands (`createExtensionAPI.registerCommand` in 0.74.0 loader). No changelog entry deprecates or rewrites it. The `getArgumentCompletions` + `handler(args, ctx)` shape used at index.ts:149–171 is the current shape.

---

### ✅ Unaffected: `pi.sendUserMessage(message)` (index.ts:145)

The runtime method is still present (`createExtensionRuntime.sendUserMessage` in 0.74.0 loader) and is still fire-and-forget — which is exactly what the `sendUserMessageAndAwaitTurn` helper compensates for via the `agent_start`/`agent_end` barrier. Critically: in `cleanup`, this fires **before** `runtime.switchSession`, so the captured `pi` is still valid when used. After the switch, the captured `pi` is never re-invoked (see stale-ctx audit above).

---

### ✅ Unaffected: other 0.68.0+ refactors

- 0.68.0 `session_shutdown` `reason` + `targetSessionFile` metadata — the extension does not subscribe to `session_shutdown`. Could theoretically be used for cleanup self-monitoring, but not required.
- 0.68.0 `ctx.fork({ position })` — unused; the extension forks via `SessionManager.forkFrom`, not `ctx.fork()`.
- 0.68.0 tool-name allowlist + removed cwd-bound exports — the extension imports zero tool factories or instances.
- 0.68.0 `loadProjectContextFiles` / `DefaultResourceLoader` cwd requirement — none of these are used.
- 0.69.0 TypeBox 1.x migration — no TypeBox usage.
- 0.71.0 message_end / editor wrapping / thinking-level events — unused.
- 0.72.0 `thinkingLevelMap` — extension does not register providers.

---

## Verdict

**must fix** — `loadSessionManager()` will throw at runtime under 0.74.0 because it walks the filesystem for a `@mariozechner/pi-coding-agent` directory that the npm rename removed; the fix is to drop the hand-rolled `require()` resolution and import `SessionManager` as a value (the loader aliases both old and new package names). Everything else (session-replacement story, removed session events, SessionManager API, `ctx.switchSession`, `ctx.sessionManager`, `pi.sendUserMessage`, `pi.registerCommand`) is unaffected: the controller’s two switch sites do no post-switch ctx/pi work, so the 0.69.0 stale-ctx footgun does not apply.
