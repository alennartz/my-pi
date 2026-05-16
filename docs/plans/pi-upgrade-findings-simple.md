# Pi 0.64.0 → 0.74.0 Upgrade — Findings (Simple Extensions)

Cross-reference of `numbered-select`, `user-edit`, `session-resume`, `model-prompt-overlays` against the distilled changelog events in `pi-upgrade-events.md`. Verified against extension source.

---

## numbered-select

Source: `extensions/numbered-select/index.ts` (sole file; helper at `lib/components/numbered-select.ts`).

### Findings

- ⚠️ **0.69.0 REFACTOR — TypeBox 1.x**
  - `index.ts:2` imports `Type` from `@sinclair/typebox`. Still aliased and works, but new code should target `typebox`.
  - Before: `import { Type } from "@sinclair/typebox";`
  - After:  `import { Type } from "typebox";`
  - Same applies to `user-edit` — coordinate.

- ✅ All other changelog events covered (no `pi.registerTool` signature changes, no session-replacement use, no cwd-bound helpers, no provider/model registration, no removed prebuilt tools).

### Silent-breakage risk (APIs not in changelog)

- `pi.registerTool(...)` field shape (`name`, `label`, `description`, `promptSnippet`, `parameters`, `execute`) — unchanged in changelog window, but worth a sanity grep in pi sources to confirm `promptSnippet` is still honored.
- `ctx.hasUI` (`index.ts:32`) — not in changelog; assumed stable.
- The helper imports `ExtensionContext`/`Theme` from `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` types — also not in changelog; assume stable but worth a `tsc`-free spot-check via pi's exported `.d.ts`.
- `PI_PARENT_LINK` env (`index.ts:9`) — internal to local `subagents` extension, not pi; out of scope.

### Verdict
**safe (refactor recommended — typebox import)**

---

## user-edit

Source: `extensions/user-edit/index.ts`.

### Findings

- ⚠️ **0.69.0 REFACTOR — TypeBox 1.x**
  - `index.ts:3` `import { Type } from "@sinclair/typebox";`
  - Same migration sketch as numbered-select.

- ✅ All other changelog events covered. `withFileMutationQueue` (`index.ts:2,37`) is not mentioned in the changelog (no add/change/remove); appears stable. `pi.registerTool` shape unchanged. No session-replacement use.

### Silent-breakage risk (APIs not in changelog)

- `withFileMutationQueue(absolutePath, asyncFn)` (`index.ts:2,37`) — not in changelog. **Flag for manual grep** to confirm the export still exists and has the same signature in 0.74.0.
- `ctx.ui.editor(title, content)` (`index.ts:32`) — not in changelog. Adjacent `ctx.ui.getEditorComponent()` was added in 0.71.0; that's a different API but suggests the editor surface is being actively developed. **Flag for manual grep** to confirm `ctx.ui.editor()` signature/return unchanged.
- `ctx.hasUI`, `ctx.cwd` — assumed stable.

### Verdict
**safe (refactor recommended — typebox import; confirm `ctx.ui.editor` + `withFileMutationQueue` still present)**

---

## session-resume

Source: `extensions/session-resume/index.ts` (+ debug-only `debug.ts`, not in extension chain).

### Findings

- ✅ **0.65.0 BREAKING — `session_switch` / `session_fork` removed, replaced by `session_start { reason }`.**
  - Extension already subscribes to `session_start` (`index.ts:16`). No code change required.
  - ⚠️ Minor REFACTOR: `event.reason` is now available. Current detection (`entries.length === 0` + `sessionEndsWithIdleMarker`) still works across all reasons. If desired, could gate behavior on `reason !== "startup"` etc., but the entry-based check is more robust (handles crashes mid-startup). Not recommended.

- ⚠️ **0.65.0 BREAKING — `AgentSessionRuntime` for session-replacement methods.** Does not apply: extension never calls `newSession()`/`switchSession()`/`fork()`.

- ⚠️ **0.69.0 BREAKING — stale `pi`/`ctx` after session replacement throw.** Does not apply directly: extension only uses `pi`/`ctx` synchronously inside event callbacks, never caches across swaps. However, `pi.appendEntry` is called from the `agent_end` callback (`index.ts:10–11`) — if `agent_end` fires during a session swap (e.g. session shutdown induced by `switchSession`), the captured `pi` could theoretically be stale. In practice the changelog says `session_shutdown` fires on the old extension instance before swap, so the `pi` inside `agent_end` is still the pre-swap one — fine. **Flag for runtime verification**: after a `/clone` or session resume, confirm the idle marker still appends correctly.

- ✅ All other events (cwd-bound API changes, TypeBox, prebuilt-tool removals, providers, thinking-level map) unaffected — extension imports only `ExtensionAPI` type.

### Silent-breakage risk (APIs not in changelog)

- `ctx.sessionManager.getBranch()`, `.getSessionFile()`, `.getEntries()` (`index.ts:5,17,18`) — **not in changelog**. SessionManager surface was reshaped around `AgentSessionRuntime` in 0.65.0; even though the public methods may be unchanged, **flag for manual grep** that `getBranch`/`getEntries` still return the same shape (the entry-type discriminator strings `"custom"`, `"message"`, `"custom_message"`, `"tool_call"`, `"tool_result"`, `"thinking"` at `index.ts:9–11` are particularly fragile).
- `pi.appendEntry(customType, data)` (`index.ts:11,23`) — not in changelog. Confirm signature unchanged.
- `pi.sendMessage(message, { triggerTurn })` with `{ customType, content, display }` payload (`index.ts:24–27`) — not in changelog. Confirm payload shape still accepted.

### Verdict
**safe (verify SessionManager / appendEntry / sendMessage signatures unchanged; one minor refactor option declined)**

---

## model-prompt-overlays

Source: `extensions/model-prompt-overlays/index.ts` (+ helper modules).

### Findings

- ⚠️ **0.68.0 REFACTOR — `before_agent_start` gains `systemPromptOptions`.**
  - `index.ts:12` ignores `systemPromptOptions` and uses `event.systemPrompt` string. Current approach (return `{ systemPrompt: event.systemPrompt + "\n\n" + block }`) is still the documented cooperative-mutation pattern.
  - Possible refactor: inspect `systemPromptOptions` to gate behavior on structured inputs (e.g. detect whether AGENTS.md context already loaded) without re-discovering. Low value here — the extension's job is just append-on-match. Not recommended.

- ✅ **0.69.0 FIXED — `ctx.getSystemPrompt()` reflects chained mutations.** Extension uses event-return-based mutation (the canonical path), so the fix is transparent. Multiple instances of this extension would correctly chain.

- ⚠️ **0.68.0 BREAKING — cwd-bound APIs lost ambient defaults (`loadProjectContextFiles`, `loadSkills`, `DefaultResourceLoader`).** Not used. Extension calls `getAgentDir()` (`index.ts:11`), which is a different export and is not listed as affected.

- ✅ All other events (TypeBox — extension uses no schema; tool registration — none; session-replacement — none; providers — none) unaffected.

### Silent-breakage risk (APIs not in changelog)

- `getAgentDir()` (`index.ts:1,11`) — not in changelog. 0.70.0 mentions hardcoded `pi`/`.pi` branding routed through `APP_NAME` / `CONFIG_DIR_NAME` extension points; this *might* affect what `getAgentDir()` returns under custom branding, but not the export itself. **Flag for manual grep** to confirm signature `(): string` unchanged.
- `parseFrontmatter<T>(content)` (`parsing.ts:4,23`) — not in changelog. Confirm still exported and shape unchanged.
- `ctx.ui.notify(message, level)` (`index.ts:18`) — not in changelog; widely used elsewhere, assumed stable.
- `ctx.model?.id`, `ctx.cwd` — assumed stable.
- Event return shape `{ systemPrompt: string } | undefined` (`index.ts:29`) — not in changelog; rely on 0.69.0's chaining-fix wording implying the shape persists.

### Verdict
**safe (one minor refactor option declined; flag `getAgentDir` + `parseFrontmatter` for signature confirmation)**

---

## Summary

| Extension | Verdict |
|---|---|
| numbered-select | safe (refactor recommended: typebox 1.x import) |
| user-edit | safe (refactor recommended: typebox 1.x import; confirm `ctx.ui.editor` + `withFileMutationQueue` still present) |
| session-resume | safe (verify SessionManager / appendEntry / sendMessage signatures) |
| model-prompt-overlays | safe (verify `getAgentDir` / `parseFrontmatter` signatures) |

**No ❌ must-fix items across the four simple extensions.** All four either don't touch the breaking surface or already use the post-0.65.0 API shape (`session_start`). The single repeated REFACTOR opportunity is the TypeBox 1.x import path (two extensions). The largest residual risk is silent breakage in unlogged APIs — primarily `ctx.sessionManager.*` shape (session-resume), `ctx.ui.editor` (user-edit), and `getAgentDir` / `parseFrontmatter` (model-prompt-overlays). A targeted grep of `@earendil-works/pi-coding-agent`'s exported `.d.ts` for these four symbols would close the gap.
