# pi 0.64.0 → 0.74.0 — `subagents` extension impact

Cross-referenced against `pi-upgrade-events.md`. Spot-checked `index.ts`, `agent-set.ts`, `agents.ts`, `stop-sequences.ts`, `widget.ts`, `rpc-child.ts`, `broker.ts`, `package.json`.

The extension is the largest API consumer in the repo (8 tools, 6 event hooks, TUI widget, custom RPC bridge to spawned `pi --mode rpc` children, broker over a UNIX socket). Surprisingly little of that surface is broken by the upgrade — the extension carefully avoids almost every hot zone (session-replacement APIs, prebuilt cwd-bound tool instances, `RpcClient`, provider/model registration).

---

## ❌ Breaking

### B1. npm scope rename — 0.74.0
- `index.ts:16`, `agent-set.ts:12`, `agents.ts:12`, `stop-sequences.ts:9`, `widget.ts:12` all import from `@mariozechner/pi-coding-agent`. Pi 0.74.0 publishes only `@earendil-works/pi-coding-agent`; the old name is no longer installed alongside the new binary (`/home/alenna/.nvm/.../node_modules/@mariozechner/` does not contain `pi-coding-agent`).
- Result at runtime: jiti module resolution fails for all five files → extension fails to load.
- Fix: replace every `@mariozechner/pi-coding-agent` import with `@earendil-works/pi-coding-agent`. No type changes — same exports (`ExtensionAPI`, `Theme`, `getAgentDir`, `parseFrontmatter`, `SettingsManager`, `DefaultPackageManager`).
- This is a repo-wide concern (every extension is hit), not subagents-specific, but it is the only hard break for this extension.

---

## ⚠️ Refactor opportunities

### R1. `session_shutdown` reason / `targetSessionFile` — 0.68.0
- `index.ts:1253` handles `session_shutdown` unconditionally: stops the broker, disconnects parent + uplink broker clients, nulls `manager`, clears the widget.
- The extension already does session-survival work in `session_start` via `mgr.restoreFromPersistence(...)` (line 358), implying it wants subagents to survive `/reload`. But because shutdown unconditionally calls `broker.stop()` and `manager = null`, every reload tears down the broker socket and any in-flight child processes the broker is fronting. Persistence only restores agents whose state was already serialized to disk; live work in transit is lost.
- With 0.68.0 metadata available, the handler can branch:
  - `reason === "quit"` → current full teardown.
  - `reason === "reload"` → keep the broker socket alive, keep child rpc-child processes attached, just detach UI state (`dashboard`, `tuiRef`, `panelHandle`) so the new extension instance can re-bind in `session_start`.
  - `reason === "new" | "resume" | "fork"` → current full teardown (different working session — children no longer logically belong).
- Sketch:
  ```
  pi.on("session_shutdown", async (event) => {
    queue.clear();
    if (event.reason === "reload" && manager) { detachUiOnly(); return; }
    /* existing teardown path */
  });
  ```
- Material UX gain: today `/reload` interrupts running subagents; with this branch they keep running across reloads.

### R2. `session_start` reason — 0.65.0
- `index.ts:349` ignores `event.reason`. Always re-discovers package agents and calls `mgr.restoreFromPersistence(...)`.
- Useful refinements:
  - `reason === "fork"` or `"new"`: the new session is a fresh branch — restoring the *previous* session's subagent persistence may be wrong (different parent session file, different child-sessions dir). Today restoration relies on `parentSessionFile` recomputed lazily inside `ensureManager`, but the cache pollution from `cachedPackageAgents` is fine. Still worth an explicit check to skip restoration when `reason !== "startup" && reason !== "reload"`.
  - Pairs with R1: when R1 keeps the broker alive across reload, R2 can skip re-running `restoreFromPersistence` because the manager is still attached.

### R3. TypeBox 1.x migration — 0.69.0
- `index.ts:17` is the *only* TypeBox import (`import { Type } from "@sinclair/typebox"`), used by all 8 tool parameter schemas. No use of `@sinclair/typebox/compiler` anywhere (verified by grep).
- Status: works as-is via the 0.69.0 alias to `typebox` 1.x. Pure refactor.
- Sketch: swap the import to `import { Type } from "typebox"` (no other call-site changes; surface of `Type.Object/String/Boolean/Array/Optional` is identical).
- Bonus: gives correct argument validation in eval-restricted runtimes (per 0.69.0 notes), though subagents always runs in Node so the practical gain is minor.

### R4. Tool `terminate: true` — 0.69.0
- None of the 8 tools currently set `terminate`. Candidates:
  - `respond` (line 919): semantically just dispatches and returns "Response sent." — there's nothing useful for the LLM to do next per-tool-call. Marking `terminate: true` would let the LLM emit the response and stop without a follow-up turn (mild token savings; minor).
  - `teardown` (line 1013) with `params.agent` omitted: nothing left to do. Similar small win.
  - `await_agents` (line 1150) and `subagent`/`fork` when `params.await` is true return notification streams the LLM definitely wants to react to — leave them.
- Strictly optional polish; no behavioral regression today.

### R5. `--no-builtin-tools` fix — 0.70.0
- `index.ts:758` defines `BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"]` and uses `pi.getActiveTools()` to compute the intersection passed to forked children. Pre-0.70.0, when the user ran with `--no-builtin-tools`, that intersection was empty *and* the extension's own tools were nuked too. Post-0.70.0 the extension tools survive; the intersection correctly resolves to an empty `tools` list (omit `--tools`). No code change needed — call this a fixed footgun.

### R6. `RpcClient` root export — 0.67.67
- `rpc-child.ts:8,57` uses Node `child_process.spawn` and rolls its own JSONL framer over stdio. It does **not** import from `@mariozechner/pi-coding-agent/.../rpc-client` or any deep path. The new root re-export of `RpcClient` is irrelevant here.
- Latent refactor: replacing the bespoke framer with the upstream `RpcClient` would dedupe ~150 lines and pick up upstream protocol fixes for free. Not required for the upgrade.

### R7. Session-replacement reference invalidation — 0.69.0
- The extension never calls `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or `importFromJsonl()` itself — so the "stale ctx throws" rule doesn't apply directly.
- But it *does* capture `pi` and `ctx`-derived values in long-lived closures:
  - `pi` is captured by the module-level `activate(pi)` arg and used inside `queue.deliver` (`pi.sendMessage(...)` at line 242) and inside event-hook handlers across the file's lifetime.
  - `ctx`-derived references (`ctx.cwd`, `ctx.sessionManager.getSessionFile()`) are captured *only* inside `ensureManager` from a per-tool-execute `ctx`, not module-level — and `session_shutdown` nulls `manager` so the next session_start gets a fresh ctx via the next tool call.
- Conclusion: safe today because (a) the extension never triggers session replacement on its own session, and (b) `session_shutdown` always fires before replacement and drops the captured state. If a future code path captures `ctx` into a long-lived closure (e.g. an idle-deadline timer), it must use `withSession`.

### R8. `afterToolCall` / `tool_result` fix — 0.67.67
- Extension does not hook `afterToolCall` or `tool_result` (verified by grep across all files). Unaffected.

### R9. TUI widget API & working indicator — 0.68.0 / 0.70.3
- `ctx.ui.setWidget("subagents", factory)` at `index.ts:553` and `ctx.ui.custom(...)` at `index.ts:547` — both signatures still present in 0.74.0 `core/extensions/types.d.ts` with the same factory shape the extension uses. ✅
- `setWorkingIndicator` / `setWorkingVisible` are new options the extension doesn't use — not relevant.
- One nit: the teardown path at `index.ts:1041` calls `ctx.ui.setWidget("subagents", undefined as any)`. The new typed overload accepts `string[] | undefined` or a factory-or-`undefined`; the `as any` cast is no longer necessary in 0.74.0 — drop the cast for cleanliness.

### R10. `defineTool()` helper — 0.65.0
- Refactor opportunity: the 8 `pi.registerTool({...})` blocks could move to `defineTool(...)` for inferred parameter types, eliminating the `_toolCallId, params, signal, _onUpdate, ctx` positional ceremony. Pure cosmetics; large diff for small win — skip unless the file gets reworked for other reasons.

---

## ✅ Unaffected (verified, listed for completeness)

- Prebuilt cwd-bound tool exports (`readTool` etc.) removed in 0.68.0 — extension uses string identifiers only.
- `loadProjectContextFiles` / `loadSkills` / `DefaultResourceLoader` ambient-cwd removal in 0.68.0 — not used.
- `session_directory` field removed in 0.65.0 — not used.
- `compat.reasoningEffortMap` → `thinkingLevelMap` (0.72.0) — extension registers no providers/models.
- `--no-context-files`, `loadProjectContextFiles` exports (0.67.4) — not used.
- `after_provider_response`, `message_end`, `thinking_level_select` new hooks (0.67.4 / 0.71.0) — extension doesn't subscribe.
- `pi.sendMessage` shape across session swaps — extension only calls it with `{customType, content, display, triggerTurn:true}` from a closure that's recreated on extension reload.
- `pi.getActiveTools()`, `pi.getCommands()`, `pi.getThinkingLevel()`, `ctx.modelRegistry.getAvailable()`, `ctx.sessionManager.getSessionFile()` — all present and unchanged in 0.74.0 types.
- `@pimote/panels` `detect(pi, "subagents")` — external package, outside the pi upgrade scope.

---

**Verdict: must fix** — single hard break is the `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent` import rename across 5 files (B1). Everything else is optional polish, with R1 (session_shutdown reason) the most worthwhile.
