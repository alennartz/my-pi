# Pi 0.64.0 → 0.74.0 — Extension-Relevant Changelog Events

Distilled from `/home/alenna/.nvm/versions/node/v25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`.
Filtered to API/SDK/extension-hook surface only — provider-internal fixes, model metadata, UI tweaks unrelated to extension API, terminal/TUI fixes that don't change extension contracts, etc., are excluded.

Tag legend:
- **BREAKING** — extension may compile/run but behavior or signature changed; mandatory review.
- **REFACTOR** — non-breaking; new capability or cleaner API that may simplify/improve extension code.

---

## 0.65.0 (2026-04-03)

- **BREAKING**: Extension events `session_switch` and `session_fork` REMOVED. Replace with `session_start` and check `event.reason` (`"startup" | "reload" | "new" | "resume" | "fork"`). For `"new" | "resume" | "fork"`, `session_start` includes `previousSessionFile`.
- **BREAKING**: Session-replacement methods removed from `AgentSession`. SDK callers must use `AgentSessionRuntime` for `newSession()`, `switchSession()`, `fork()`, `importFromJsonl()`. Cross-cwd session replacement now rebuilds all cwd-bound runtime state and replaces the live `AgentSession` instance.
- **BREAKING**: `session_directory` field removed from extension and settings APIs.
- **BREAKING**: Unknown single-dash CLI flags (e.g. `-s`) now error instead of being silently ignored.
- **REFACTOR**: `defineTool()` helper for standalone/array custom tool definitions with proper inferred TypeScript parameter types — eliminates manual `as` casts.
- **REFACTOR**: Unified diagnostics model (`info`/`warning`/`error`) replaces direct logging/exit for arg parsing, service creation, session option resolution, resource loading. App layer decides presentation.
- **REFACTOR**: `/tree` gains `Shift+T` label timestamps with smart formatting + preservation across branches.

## 0.66.0 / 0.66.1 (2026-04-08)

- No extension-API changes.

## 0.67.1 (2026-04-13)

- Telemetry ping (interactive only, disable via `PI_TELEMETRY=0` / `PI_OFFLINE=1` / settings). Not an extension API change.
- **REFACTOR**: `PI_CODING_AGENT=true` env var set at startup — subprocesses can detect they're inside the coding agent.
- **REFACTOR**: Full `openRouterRouting` field support in `models.json`.

## 0.67.2 (2026-04-14)

- **REFACTOR**: Multiple `--append-system-prompt` flags supported.
- **REFACTOR**: Inline extension factories can be passed to `main()` for embedded integrations.

## 0.67.3 (2026-04-15)

- **REFACTOR**: `renderShell: "self"` for custom and built-in tool renderers — tools can own outer shell instead of default boxed shell. Useful for stable large previews (e.g. diffs).
- **REFACTOR**: Interactive auto-retry status shows live countdown during backoff.

## 0.67.4 (2026-04-16)

- **REFACTOR**: `--no-context-files` / `-nc` flag to disable `AGENTS.md` / `CLAUDE.md` auto-discovery.
- **REFACTOR**: `loadProjectContextFiles()` now exported as a standalone utility — no need to instantiate `DefaultResourceLoader` to discover context files.
- **REFACTOR**: New `after_provider_response` extension hook — inspect provider HTTP status + headers immediately after response, before stream consumption.

## 0.67.5 (2026-04-16)

- No extension-API changes.

## 0.67.6 (2026-04-16)

- **REFACTOR**: Prompt templates support `argument-hint` frontmatter field — renders before description in `/` autocomplete (`<required>`, `[optional]` syntax).
- **REFACTOR**: `after_provider_response` extension hook (also listed in 0.67.4 — re-announced here).
- **REFACTOR**: Compact interactive startup header; `Ctrl+O` toggles expanded listing.
- **REFACTOR**: OSC 8 hyperlinks for markdown links on supporting terminals.

## 0.67.67 / 0.67.68 (2026-04-17)

- **REFACTOR**: Bedrock bearer-token auth.
- **REFACTOR**: Root exports for `RpcClient` and RPC protocol types from `@mariozechner/pi-coding-agent` — ESM consumers can now import them from main package entrypoint instead of deep paths.
- **FIXED** (`afterToolCall` / `tool_result` extension hook): error results now forward `details` and `isError` overrides via `AgentSession` instead of dropping them when `isError` was already true. Behavior of these hooks expanded for error tool results.
- **FIXED**: `afterToolCall` hook throws in parallel tool-call finalization are now converted to error tool results instead of aborting the remaining batch.

## 0.68.0 (2026-04-20)

- **BREAKING**: SDK & CLI tool selection moved from cwd-bound `Tool[]` instances to tool-name allowlists (`string[]`). `createAgentSession({ tools })` now expects `["read", "bash"]` not `[readTool, bashTool]`. `--tools` allowlists by name. `--no-tools` now disables ALL tools (previously only built-ins).
- **BREAKING**: Removed prebuilt cwd-bound exports from `@mariozechner/pi-coding-agent`:
  - Tool instances: `readTool`, `bashTool`, `editTool`, `writeTool`, `grepTool`, `findTool`, `lsTool`
  - Bundles: `readOnlyTools`, `codingTools`
  - Definitions: corresponding `*ToolDefinition` values
  - Replace with factories: `createReadTool(cwd)`, `createBashTool(cwd)`, `createCodingTools(cwd)`, `createReadToolDefinition(cwd)`, etc.
- **BREAKING**: Ambient `process.cwd()` / default agent-dir fallback REMOVED from public resource helpers. `DefaultResourceLoader`, `loadProjectContextFiles()`, `loadSkills()` now require explicit cwd/agent-dir inputs. Exported system-prompt option types now require explicit `cwd` field.
- **REFACTOR**: `ctx.ui.setWorkingIndicator()` — extensions can customize/animate/static/hide the streaming working indicator. Custom frames render verbatim (no theme-color override).
- **REFACTOR**: `before_agent_start` event gains `systemPromptOptions: BuildSystemPromptOptions` — inspect structured system-prompt inputs without re-discovering resources.
- **REFACTOR**: `/clone` slash command (duplicate current branch); `ctx.fork()` gains `{ position: "before" | "at" }` option — fork before a user message or duplicate current point.
- **REFACTOR**: `session_shutdown` event gains `reason` (`"quit" | "reload" | "new" | "resume" | "fork"`) and `targetSessionFile` metadata so extensions can distinguish teardown paths.
- **REFACTOR**: Configurable keybinding ids for scoped model selector + tree filter actions.
- **REFACTOR**: `PI_OAUTH_CALLBACK_HOST` env var.

## 0.68.1 (2026-04-22)

- **REFACTOR**: Configurable inline tool image width via `terminal.imageWidthCells`.
- **REFACTOR**: Fireworks provider built-in.

## 0.69.0 (2026-04-22)

- **BREAKING**: TypeBox migration from `@sinclair/typebox` 0.34.x to `typebox` 1.x. New extensions/SDK should depend on and import from `typebox`. Legacy root `@sinclair/typebox` package is still aliased, but `@sinclair/typebox/compiler` is no longer shimmed. New TypeBox-native validator path: tool argument validation now works in eval-restricted runtimes (Cloudflare Workers, etc.) instead of being skipped.
- **BREAKING**: Session-replacement commands now invalidate captured pre-replacement `pi` / `ctx` references after `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, and imported-session replacements. Stale references now THROW instead of silently targeting the replaced session. Migration: pass a `withSession` callback to those methods and use the `ReplacedSessionContext` passed to it for post-switch work. Footguns: `withSession` runs after `session_shutdown` fired on old extension instance; captured `const sm = ctx.sessionManager` etc. must NOT be reused after a switch.
- **REFACTOR**: Tool `terminate: true` — custom tools can end the current tool batch without an automatic follow-up LLM call. Useful for terminating-output tools (e.g. final structured-output emit).
- **REFACTOR**: `ctx.ui.addAutocompleteProvider(...)` — stacked extension autocomplete providers layered on top of built-in slash/path provider.
- **REFACTOR**: OSC 9;4 terminal progress indicators (in 0.69.0, but made opt-in default-off in 0.70.0).
- **FIXED**: `ctx.getSystemPrompt()` inside `before_agent_start` now reflects chained system-prompt changes made by earlier `before_agent_start` handlers (cooperative system-prompt mutation works correctly).

## 0.70.0 (2026-04-23)

- **BREAKING**: OSC 9;4 terminal progress indicators now opt-in (off by default). Toggle via `terminal.showTerminalProgress` in `/settings`. Only relevant if your extension relied on progress output.
- **FIXED**: `--no-builtin-tools` / `createAgentSession({ noTools: "builtin" })` now correctly disables ONLY built-in tools while keeping extension/custom tools active. Previously fell through to "disable everything." If you have extension-provided tools, this fix preserves them.
- **REFACTOR**: Stale extension context errors after session replacement now point extension authors to `withSession`.
- **REFACTOR**: `SettingsManager.inMemory()` now preserves initial settings across SDK-triggered reloads.
- **REFACTOR**: Hardcoded `pi`/`.pi` branding routed through `APP_NAME` / `CONFIG_DIR_NAME` extension points.
- **FIXED**: Extension shortcut conflict diagnostics now shown at startup, not just on reload.
- **FIXED**: `ctx.ui.setWorkingMessage()` persists across loader recreation (matches `setWorkingIndicator()`).

## 0.70.1 (2026-04-24)

- **REFACTOR**: Provider request timeout/retry controls (`retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}`).
- **REFACTOR**: Extension flag docs clarified — use `pi.getFlag()` with registered name (no `--` prefix).

## 0.70.2 (2026-04-24)

- No extension-API changes.

## 0.70.3 (2026-04-27)

- **REFACTOR**: `ctx.ui.setWorkingVisible()` — hide built-in interactive working loader row without reserving layout space. Useful for extensions providing custom working-state rendering (border-status editor example added).
- **REFACTOR**: Extension `pi.setSessionName()` updates now refresh interactive terminal title immediately.
- **FIXED**: Escape interrupt handling when extensions hide built-in working loader row.
- **REFACTOR**: `warnings.anthropicExtraUsage` settings flag.

## 0.70.4 / 0.70.5 / 0.70.6 (2026-04-27/28)

- No extension-API changes.

## 0.71.0 (2026-04-30)

- **BREAKING**: Removed built-in Google Gemini CLI and Google Antigravity providers + their example extensions. Only matters if an extension depended on those providers being present.
- **REFACTOR**: `message_end` extension event can return a replacement for the finalized message — enables extensions to override assistant usage/cost.
- **REFACTOR**: `ctx.ui.getEditorComponent()` — extensions can wrap the currently configured custom editor factory.
- **REFACTOR**: `thinking_level_select` extension event — observe thinking-level changes.
- **REFACTOR**: `pi.registerProvider()` supports top-level `name` field for friendly `/login` display.
- **REFACTOR**: `PI_CODING_AGENT_SESSION_DIR` env var = `--session-dir`.
- **REFACTOR**: Cloudflare AI Gateway, Moonshot AI built-in providers.

## 0.72.0 (2026-05-01)

- **BREAKING**: `compat.reasoningEffortMap` REPLACED by model-level `thinkingLevelMap` in `models.json` and `pi.registerProvider()` model definitions. Migration: move mappings from `compat.reasoningEffortMap` to `thinkingLevelMap`. String values for provider-specific thinking values; `null` for unsupported pi levels (hidden + skipped by cycling). See `docs/models.md#thinking-level-map`.
- **REFACTOR**: `shouldStopAfterTurn` agent loop callback — exit gracefully after a completed turn (from `@mariozechner/pi-agent-core`).
- **REFACTOR**: `pi.registerProvider()` honors per-model `baseUrl` overrides.

## 0.72.1 (2026-05-02)

- No extension-API changes.

## 0.73.0 (2026-05-04)

- **BREAKING** (provider config only): `xiaomi` provider switched from Token Plan AMS to API billing. `XIAOMI_API_KEY` now refers to API billing key. New `xiaomi-token-plan-{cn,ams,sgp}` providers for old Token Plan users.
- **REFACTOR**: Incremental bash output streaming.
- **REFACTOR**: Compact `read` rendering for Pi docs / AGENTS context / SKILL.md by default.

## 0.73.1 (2026-05-07)

- **REFACTOR**: Interactive OAuth login can present multiple choices (provider-specific flows).
- **REFACTOR**: JSONC-style `models.json` parsing (comments + trailing commas allowed).
- **REFACTOR**: Extension loading uses upstream `jiti` 2.7 instead of `@mariozechner/jiti` fork.

## 0.74.0 (2026-05-07)

- **BREAKING** (package only): npm scope migration `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`. `pi update --self` supports it. Repository links updated. If extensions pin the package name, peerDependencies field may need updating (but project uses `"*"` so unaffected).

---

## Cross-Extension Themes

- **Session-replacement story changed twice** (0.65.0 + 0.69.0): if an extension uses `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `pi.appendEntry()` across session swaps, or listens for `session_switch`/`session_fork`, it MUST be reviewed.
- **Cwd-bound APIs lost ambient defaults** (0.68.0): if an extension calls `loadProjectContextFiles()`, `loadSkills()`, `DefaultResourceLoader`, or constructs `BuildSystemPromptOptions`, it must pass explicit `cwd`.
- **Prebuilt tool exports removed** (0.68.0): only matters if an extension imports `readTool`, `bashTool`, etc. directly.
- **TypeBox 1.x** (0.69.0): existing `@sinclair/typebox` imports still work via alias, but new extensions should use `typebox`. `@sinclair/typebox/compiler` no longer shimmed.
- **thinkingLevelMap** (0.72.0): only matters for extensions that register providers/models with reasoning effort metadata.
