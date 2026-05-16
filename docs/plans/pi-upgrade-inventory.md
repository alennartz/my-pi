# Extension API Surface Inventory (per ext-surface scout, baseline pi 0.64.0)

This is the raw surface inventory used as input for the cross-reference pass. Each extension section lists imports, registered hooks, API calls with file:line citations, types referenced, and files.

---

## azure-foundry

**Purpose:** Provider extension auto-discovering Azure AI Foundry model deployments and registering them as pi models with dynamic Azure AD token management.

### Imports
- `@mariozechner/pi-ai`: `Api`, `AssistantMessageEventStream`, `Context`, `Model`, `SimpleStreamOptions`, `streamSimpleAnthropic`, `streamSimpleOpenAICompletions`, `streamSimpleOpenAIResponses` (index.ts:28-35)
- `@mariozechner/pi-coding-agent`: `ExtensionAPI` type (index.ts:36)

### Extension Hooks Registered
- `pi.registerProvider()` (index.ts:297) — one provider per backend:
  - `azure-foundry-anthropic-messages`
  - `azure-foundry-openai-responses`
  - `azure-foundry-openai-completions`

### Public API Touch Points
- `pi.registerProvider(providerId, { baseUrl, apiKey, api, models[], streamSimple })` (index.ts:297)
- `streamSimpleAnthropic`, `streamSimpleOpenAICompletions`, `streamSimpleOpenAIResponses` (index.ts:131, 141, 149)
- `Model` type with `id`, `name`, `reasoning`, `input[]`, `cost`, `contextWindow`, `maxTokens` (index.ts:225–237)

### Types Referenced
`Api`, `AssistantMessageEventStream`, `Context`, `Model<Api>`, `SimpleStreamOptions`

### Files
- `index.ts` — provider registration, Azure AD token caching, deployment discovery, backend routing

---

## model-prompt-overlays

**Purpose:** Discovers `AGENTS.*.md` overlay files and appends matching content to system prompt based on model ID glob patterns.

### Imports
- `@mariozechner/pi-coding-agent`: `getAgentDir`, `ExtensionAPI` type, `parseFrontmatter` (index.ts:1–3; parsing.ts:4)

### Extension Hooks Registered
- `pi.on("before_agent_start", (event, ctx) => {...})` (index.ts:8)

### Public API Touch Points
- `pi.on("before_agent_start", callback)` (index.ts:8)
- Event return: `{ systemPrompt: string } | undefined` (index.ts:29)
- `ctx.cwd` (index.ts:11), `ctx.model?.id` (index.ts:10), `ctx.ui.notify(message, level)` (index.ts:18)
- `getAgentDir()` (index.ts:11)
- `parseFrontmatter<T>(content)` (parsing.ts:23)

### Types Referenced
`ExtensionAPI`; frontmatter type with `models: string | string[]`

### Files
- `index.ts` — Main hook handler, overlay matching orchestration
- `discovery.ts` — `discoverContextRoots(cwd, agentDir)`
- `parsing.ts` — `loadOverlayFiles(dir)`
- `matching.ts` — Glob-based model ID matching
- `rendering.ts` — Format overlay blocks for system prompt append
- `diagnostics.ts` — Per-session notification deduplication
- `*.test.ts`

---

## numbered-select

**Purpose:** LLM tool `ask_user` providing numbered-list single-select UI with annotation.

### Imports
- `@mariozechner/pi-coding-agent`: `ExtensionAPI` type (index.ts:1)
- `@sinclair/typebox`: `Type` (index.ts:2)
- Local: `showNumberedSelect` from `lib/components/numbered-select.ts` (index.ts:3)

### Extension Hooks Registered
- `pi.registerTool({ name: "ask_user", ... })` (index.ts:6)

### Public API Touch Points
- `pi.registerTool({ name, label, description, promptSnippet, parameters, execute })` (index.ts:6)
- `ctx.hasUI` (index.ts:32), `ctx` passed to `showNumberedSelect(ctx, title, options)` (index.ts:41)
- Tool result: `{ content: [{ type: "text", text: string }] }` (index.ts:43–47)
- `Type.Object()`, `Type.String()`, `Type.Array()`, `Type.Optional()` (index.ts:13–24)

### Types Referenced
`ExtensionAPI`

### Files
- `index.ts` — Tool definition, execute handler
- `lib/components/numbered-select.ts` — `showNumberedSelect(ctx, title, options)`

---

## session-resume

**Purpose:** Detects interrupted sessions and injects resume markers on restart.

### Imports
- `@mariozechner/pi-coding-agent`: `ExtensionAPI` type (index.ts:1)

### Extension Hooks Registered
- `pi.on("agent_end", callback)` (index.ts:9)
- `pi.on("session_start", callback)` (index.ts:16)

### Public API Touch Points
- `ctx.sessionManager.getBranch()` (index.ts:5)
- `ctx.sessionManager.getSessionFile()` (index.ts:17)
- `ctx.sessionManager.getEntries()` (index.ts:18)
- `pi.appendEntry(customType, data)` (index.ts:11, 23)
- `pi.sendMessage(message, { triggerTurn })` (index.ts:25)

### Types Referenced
`ExtensionAPI`

### Files
- `index.ts`
- `debug.ts`

---

## subagents

**Purpose:** Long-lived subagent orchestration — spawns RPC child processes, manages channels, coordinates messaging, provides 8 subagent tools.

### Imports
- `@mariozechner/pi-coding-agent`: `ExtensionAPI` type, `TUI` type (index.ts:11, 17)
- `@mariozechner/pi-tui`: `TUI` type (index.ts:17)
- `@sinclair/typebox`: `Type` (index.ts:16)
- `@pimote/panels`: `detect` (index.ts:18)
- Local: `AgentConfig`, `discoverAgents`, `discoverPackageAgents`, agents.ts, broker.ts, widget.ts, etc. (index.ts:13–24)

### Extension Hooks Registered
- 8 tools via `pi.registerTool()`:
  - `subagent` (753), `fork` (838), `send` (901), `respond` (956), `check_status` (985), `teardown` (1009), `resurrect` (1062), `await_agents` (1122), `interrupt` (1148)
- Event hooks:
  - `agent_start` (362), `agent_end` (366)
  - `tool_execution_start`/`tool_execution_end` (370–375, gated by `USE_STEER_DELIVERY`)
  - `session_start` (381), `before_agent_start` (452), `session_shutdown` (1203)

### Public API Touch Points
- `pi.registerTool({ name, label, description, promptGuidelines, parameters, execute })` (8 tools, 753–1178)
- `pi.on("agent_start" | "agent_end" | "tool_execution_start" | "tool_execution_end" | "session_start" | "before_agent_start" | "session_shutdown", callback)` (362–375, 381, 452, 1203)
- `pi.getActiveTools()` (630, 756)
- `pi.getCommands()` (725)
- `pi.getThinkingLevel()` (719)
- `pi.sendMessage(msg, { triggerTurn })` (353)
- `pi.sendUserMessage(message)` (333)
- `ctx.ui.setWidget(name, factory)` (509)
- `ctx.ui.custom(renderer, options)` (505)
- `ctx.ui.notify(message, level)`
- `ctx.cwd` (530, 534, etc.)
- `ctx.sessionManager.getSessionFile()` (477, 718)
- `ctx.modelRegistry.getAvailable()` (607)
- `ctx.sessionManager` (various)
- `detect(pi, widgetName)` (510)

### Types Referenced
`ExtensionAPI`, `TUI`, `Theme`, `Component`, `Focusable`, `AgentConfig`, `AgentSpec`, `ForkAgentSpec`, `RegularAgentSpec`, `AgentStatus`, `AgentState`, `PanelHandle`, `Card`, `CardColor`

### Files
- `index.ts`, `agent-set.ts`, `agents.ts`, `broker.ts`, `channels.ts`, `rpc-child.ts`, `messages.ts`, `notification-queue.ts`, `stop-sequences.ts`, `widget.ts`, `deadlock.ts`, `persistence.ts`, `tool-result.ts`, `*.test.ts`

---

## toolscript

**Purpose:** MCP integration — spawns toolscript child process, surfaces MCP tools as pi tools.

### Imports
- `@mariozechner/pi-coding-agent`: `ExtensionAPI` type (index.ts:1)
- `@sinclair/typebox`: `TSchema` type (index.ts:2)
- `@modelcontextprotocol/sdk`: `Client`, `StdioClientTransport` (client.ts:4–5)

### Extension Hooks Registered
- `pi.on("session_start", callback)` (index.ts:6)
- `pi.on("session_shutdown", callback)` (index.ts:21)
- `pi.registerTool()` — one tool per MCP tool, prefixed `toolscript_` (index.ts:13)

### Public API Touch Points
- `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute })` (index.ts:13)
- `execute` callback receives tool call ID, params, signal (abort), onUpdate — NO ctx (index.ts:17)
- Tool result: `{ content: [{ type: "text", text: string }], details: { isError: bool } }` (index.ts:19)

### Types Referenced
`ExtensionAPI`, `TSchema`; MCP types `Client`, `StdioClientTransport`

### Files
- `index.ts`
- `client.ts` — `ToolscriptClient` class

---

## user-edit

**Purpose:** LLM tool `user_edit` — opens file in built-in editor, writes saved changes to disk.

### Imports
- `@mariozechner/pi-coding-agent`: `ExtensionAPI` type, `withFileMutationQueue` (index.ts:1–2)
- `@sinclair/typebox`: `Type` (index.ts:3)
- Node.js: `readFile`, `writeFile`, `mkdir` from `fs/promises`; `resolve`, `dirname` from `path` (index.ts:4–5)

### Extension Hooks Registered
- `pi.registerTool({ name: "user_edit", ... })` (index.ts:7)

### Public API Touch Points
- `pi.registerTool({ name, label, description, parameters, execute })` (index.ts:7)
- `ctx.hasUI` (index.ts:17), `ctx.cwd` (index.ts:22), `ctx.ui.editor(title, content)` (index.ts:32)
- Tool result: `{ content: [{ type: "text", text: string }] }` (index.ts:35, 39)
- `withFileMutationQueue(absolutePath, asyncFn)` (index.ts:37)
- `Type.Object()`, `Type.String()` (index.ts:13–14)

### Types Referenced
`ExtensionAPI`

### Files
- `index.ts`
- `index.test.ts`

---

## worktree

**Purpose:** Git worktree lifecycle management — create, resume, cleanup branches with session transfer and stash-based change portability.

### Imports
- `@mariozechner/pi-coding-agent`: `ExtensionAPI`, `ExtensionCommandContext`, `SessionManager` type (index.ts:7–8)
- `@mariozechner/pi-tui`: `AutocompleteItem` type (index.ts:9)
- Local: command-surface parsing, controller factory (index.ts:10–11)

### Extension Hooks Registered
- `pi.registerCommand("/worktree", { description, getArgumentCompletions, handler })` (index.ts:149)
- `pi.on("agent_start", callback)` (index.ts:137)
- `pi.on("agent_end", callback)` (index.ts:142)

### Public API Touch Points
- `pi.registerCommand(name, { description, getArgumentCompletions, handler })` (index.ts:149)
- Argument autocomplete callback (index.ts:150); handler receives `args`, `ctx` (index.ts:152)
- `pi.on("agent_start" | "agent_end", callback)` (137, 142)
- `ctx.cwd` (156)
- `ctx.ui.select(question, options)` (95, 105)
- `ctx.ui.notify(message, level)` (108)
- `ctx.switchSession(sessionFile)` (110) ← session-replacement API
- `ctx.sessionManager.getSessionDir()` (126)
- `ctx.sessionManager.getSessionFile()` (127)
- `pi.sendUserMessage(message)` (145)
- `SessionManager.continueRecent(cwd, sessionDir)` (159)
- `SessionManager.create(cwd, sessionDir)` (162)
- `SessionManager.forkFrom(sourceSessionPath, targetCwd, sessionDir)` (169)
- Session methods: `appendCustomEntry()`, `getSessionFile()` (168, 172)

### Types Referenced
`ExtensionAPI`, `ExtensionCommandContext`, `SessionManager`, `AutocompleteItem`; internal `WorktreeDependencies`, `WorktreeInfo`, `PendingChangesChoice`, `ContextTransferChoice`

### Files
- `index.ts`, `command-surface.ts`, `controller.ts`, `contracts.ts`, `*.test.ts`
