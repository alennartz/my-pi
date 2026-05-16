# Pi 0.64.0 → 0.74.0 — `toolscript` Extension Findings

Scope: `extensions/toolscript/{index.ts,client.ts,package.json}`. The extension spawns the `toolscript` MCP server as a child process on `session_start`, lists its tools, and registers each one as a pi tool whose `execute` proxies into the MCP client. On `session_shutdown` it closes the client.

Surface actually touched by the extension:
- `ExtensionAPI` type import from `@mariozechner/pi-coding-agent` (index.ts:1)
- `TSchema` type import from `@sinclair/typebox` (index.ts:2)
- `pi.on("session_start", …)` (index.ts:6)
- `pi.on("session_shutdown", …)` (index.ts:21)
- `pi.registerTool({...})` with `parameters: TSchema`, `execute(toolCallId, params)` (index.ts:21–37)
- Tool result shape `{ content: [{ type: "text", text }], details: { isError } }` (index.ts:31–34)
- `ctx.cwd` (index.ts:7)

No use of: `defineTool`, `pi.appendEntry`, `ctx.fork`/`newSession`/`switchSession`, `ctx.sessionManager`, `before_agent_start`, `after_provider_response`, `message_end`, prebuilt tool exports, `loadProjectContextFiles`, `DefaultResourceLoader`, `loadSkills`, `BuildSystemPromptOptions`, `pi.registerProvider`, `compat.reasoningEffortMap`, `setWorkingIndicator/Visible`, autocomplete providers, `terminate`, `--no-context-files`, etc. Most of the changelog is therefore irrelevant.

---

## Per-API classification

### `pi.registerTool` shape and tool-result format — ✅ Unaffected (with a footnote)

The `{ content, details: { isError } }` return at index.ts:31–34 is the same shape the API has accepted throughout 0.64–0.74. The 0.67.67 fix to `afterToolCall` / `tool_result` is an *improvement*: error tool results no longer drop the extension's `details` and `isError` overrides on the way through `AgentSession`. Toolscript's behavior under this fix is strictly better — when the MCP child returns `isError: true`, downstream hooks now see the flag instead of having it silently coerced. No code change needed.

The companion 0.67.67 fix (throws inside `afterToolCall` during parallel finalization become error results instead of aborting the batch) is also defensive in the extension's favor.

The `execute` callback signature (`async execute(_toolCallId, params)` — no `signal`, no `onUpdate`, no `ctx`) remains valid. None of the entries between 0.65.0 and 0.74.0 alter the `execute` signature.

### TypeBox `TSchema` import — ⚠️ Refactor opportunity, not breaking

index.ts:2 imports `TSchema` from `@sinclair/typebox`. 0.69.0 migrated pi's internals to `typebox` 1.x but the legacy root `@sinclair/typebox` package remains aliased, so the import keeps resolving and `TSchema` keeps meaning the same thing for tool-parameter typing. The only thing that *broke* under 0.69.0 is `@sinclair/typebox/compiler`, which the extension doesn't touch (it just casts `mcpTool.inputSchema as TSchema` — no validator compilation on the extension side).

Refactor (optional): switch the import to `typebox` to align with the new world and stop relying on the alias. Mechanical, single line. Leave alone if you want zero diff.

### `session_start` event — ⚠️ Refactor opportunity, not breaking

index.ts:6 hooks `session_start` and ignores the event payload (`_event`). 0.65.0 expanded that payload with `reason: "startup" | "reload" | "new" | "resume" | "fork"` and (for the last three) `previousSessionFile`. The handler still fires on every session start, so behavior is preserved — but the extension is currently doing the same thing for every reason, which is actually correct for an MCP child:

- On `startup` / `reload`: spawn fresh — correct.
- On `new` / `resume` / `fork`: previous handler already received `session_shutdown` (per 0.69.0 docs the shutdown fires before the replacement), so the old client was stopped. The current code then starts a fresh one — correct.

So there's no functional bug. The refactor opportunity is purely diagnostic: `event.reason` could be logged, and on `fork` you might *not* want a brand-new MCP child if the goal is to keep parent state visible — but that's a product call, not an upgrade hazard. The extension also doesn't need `previousSessionFile` since it carries no per-session state on disk.

Note the 0.65.0 BREAKING removal of `session_switch` / `session_fork` events: the extension never registered for those, so nothing to migrate.

### `session_shutdown` event — ⚠️ Refactor opportunity, not breaking

index.ts:21 hooks `session_shutdown` and ignores the event. 0.68.0 added `reason` (`"quit" | "reload" | "new" | "resume" | "fork"`) and `targetSessionFile`. The current handler unconditionally closes the MCP client, which is the safe default — there's no resource the extension would want to hold open across `reload`/`fork`, because `session_start` will rebuild from scratch.

Optional refactor: on `reason === "reload"` you *could* keep the MCP child alive to avoid respawn cost, but that's an optimization, not a correctness issue, and it complicates the lifecycle (you'd need to re-register the tools without restarting the child). Recommend leaving as-is.

### Tool `execute` callback signature — ✅ Unaffected

`async execute(_toolCallId, params)` continues to match the signature pi expects. The extension does not use `signal` or `onUpdate`, which is fine — they remain optional parameters. No version in this range narrowed or widened required arity.

### `ctx.cwd` — ✅ Unaffected

Used at index.ts:7 to seed the `ToolscriptClient`. `ctx.cwd` is stable through the range. The 0.68.0 BREAKING removal of ambient `process.cwd()` defaults applies to `DefaultResourceLoader` / `loadProjectContextFiles` / `loadSkills` — the extension touches none of those.

### Package-name migration (0.74.0) — ⚠️ Watch, but not breaking here

0.74.0 renamed the published package from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent`. The extension imports `ExtensionAPI` from `@mariozechner/pi-coding-agent` (index.ts:1). `package.json` declares no `dependencies` / `peerDependencies` — type resolution rides entirely on whichever package the host installation exposes. As long as the old name remains importable (the changelog suggests `pi update --self` handles the rename, and the my-pi tree itself still uses the old name everywhere), this keeps working. If/when the legacy name is dropped upstream, switch the import to `@earendil-works/pi-coding-agent`. Same one-line refactor opportunity applies to the sibling `extensions/` if/when you do a sweep.

### Other BREAKING entries — ✅ Unaffected

- 0.65.0 `session_directory` removal — not referenced.
- 0.65.0 `AgentSessionRuntime` SDK split — SDK-only, no impact on extension hooks.
- 0.65.0 unknown single-dash flags now error — irrelevant.
- 0.68.0 tool allowlist `string[]` migration — extension doesn't call `createAgentSession` or pass tool instances anywhere; it only *registers* a tool by name.
- 0.68.0 prebuilt cwd-bound tool exports removed — extension imports none of `readTool`/`bashTool`/etc.
- 0.68.0 ambient `cwd` defaults removed — extension passes `ctx.cwd` explicitly.
- 0.69.0 stale `pi` / `ctx` refs after session replacement — extension does not capture `pi` or `ctx` outside the handler closures and never calls `ctx.newSession`/`fork`/`switchSession`.
- 0.70.0 OSC 9;4 opt-in — no progress output.
- 0.71.0 Gemini/Antigravity provider removal — no provider use.
- 0.72.0 `compat.reasoningEffortMap` → `thinkingLevelMap` — no provider registration.
- 0.73.0 xiaomi billing — irrelevant.

---

## Verdict

safe
