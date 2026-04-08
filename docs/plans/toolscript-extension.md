# Plan: Toolscript Pi Extension

## Context

Build a pi extension that integrates toolscript — spawning it as a long-lived child process and surfacing its MCP tools as pi tools. See [brainstorm](../brainstorms/toolscript-extension.md) for full exploration and decision rationale.

## Architecture

### New Modules

#### Toolscript Extension (`extensions/toolscript/`)

Standalone pi extension. No dependencies on other extension modules.

**Responsibilities:** toolscript process lifecycle, MCP client management, pi tool registration, config file resolution, crash recovery

**Files:**
- `extensions/toolscript/package.json` — extension manifest, declares `@modelcontextprotocol/sdk` dependency
- `extensions/toolscript/index.ts` — extension entry point: `session_start`/`session_shutdown` handlers, tool registration, prompt guidelines
- `extensions/toolscript/client.ts` — `ToolscriptClient` class: spawns toolscript, manages MCP connection over stdio, handles crash/restart

### Interfaces

#### ToolscriptClient (`client.ts` → `index.ts`)

```typescript
interface McpToolDef {
  name: string;          // e.g. "list_apis"
  description: string;   // from MCP tools/list
  inputSchema: object;   // JSON Schema from MCP tools/list
}

interface StartResult {
  tools: McpToolDef[];    // tool definitions from tools/list
  instructions: string;   // from initialize response server info
}

interface CallToolResult {
  content: string;        // text content from MCP response
  isError: boolean;       // whether toolscript reported an error
}

class ToolscriptClient {
  // Resolve binary (TOOLSCRIPT_BIN env var → "toolscript" on $PATH).
  // Resolve config files:
  //   - ~/.pi/toolscript/toolscript.toml (user-level base)
  //   - ./toolscript.toml (project-level overlay)
  // Spawn `toolscript run --config <files...>` as child process on stdio.
  // Connect MCP client via @modelcontextprotocol/sdk StdioClientTransport.
  // Call initialize, then tools/list.
  // Return tool definitions and instructions string.
  // If no config files exist, throw (caller handles by staying dormant).
  start(): Promise<StartResult>;

  // Proxy a tool call to toolscript via MCP tools/call.
  // If the process is dead (crashed), auto-restart before returning error.
  // The failed call itself returns an error — does not silently retry.
  // Subsequent calls go through the restarted process.
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;

  // Kill the child process and clean up.
  stop(): Promise<void>;
}
```

#### Extension ↔ Pi (`index.ts`)

The extension default export wires `ToolscriptClient` to pi's lifecycle and tool system:

- **`session_start`**: Instantiate `ToolscriptClient`, call `start()`. If it throws (no config), return early — extension stays dormant. Otherwise, for each tool in `StartResult.tools`, call `pi.registerTool()`:
  - Tool name: `toolscript_${mcpTool.name}` (e.g. `toolscript_list_apis`)
  - `description`: from `mcpTool.description`
  - `promptSnippet`: from `mcpTool.description` (one-liner)
  - `promptGuidelines`: only on `toolscript_list_apis` — derived from `StartResult.instructions`
  - `parameters`: from `mcpTool.inputSchema`
  - `execute`: calls `client.callTool(mcpTool.name, params)`, maps `CallToolResult` to pi tool result format

- **`session_shutdown`**: Call `client.stop()`.

#### Config Resolution (internal to `client.ts`)

Precedence for `--config` arguments passed to `toolscript run`:

1. If both `~/.pi/toolscript/toolscript.toml` and `./toolscript.toml` exist: `--config <user> --config <project>` (user base, project overlays)
2. If only one exists: `--config <that one>`
3. If neither exists: throw — no toolscript available

### Technology Choices

**MCP Client: `@modelcontextprotocol/sdk`**
- **Chosen** because it's the official maintained SDK, handles JSON-RPC framing, stdio transport, and the full MCP handshake.
- **Considered** hand-rolling a minimal client (~100-150 lines for the small protocol surface). Rejected — no reason to reimplement what a maintained library provides, even if the surface is small.

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

## Steps

**Pre-implementation commit:** `2e510ed146e555047d98e93371b1dad531873f09`

### Step 1: Create extension manifest and install dependency

Create `extensions/toolscript/package.json` with the pi extension manifest structure and the `@modelcontextprotocol/sdk` dependency.

The manifest declares the extension entry point and its single npm dependency:

```json
{
  "name": "toolscript",
  "version": "1.0.0",
  "description": "Toolscript MCP integration — spawns toolscript as a child process and surfaces its tools in pi",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "..."
  }
}
```

After creating the file, run `npm install` in `extensions/toolscript/` to install the SDK and generate the lockfile.

**Verify:** `extensions/toolscript/node_modules/@modelcontextprotocol/sdk` exists and `extensions/toolscript/package-lock.json` is generated.
**Status:** done

### Step 2: Implement `ToolscriptClient` in `client.ts`

Create `extensions/toolscript/client.ts` containing the `ToolscriptClient` class and its supporting types.

**Types to export:**

```typescript
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export interface StartResult {
  tools: McpToolDef[];
  instructions: string;
}

export interface CallToolResult {
  content: string;
  isError: boolean;
}
```

**`ToolscriptClient` class — public API:**

```typescript
export class ToolscriptClient {
  constructor(cwd: string);  // cwd needed for resolving ./toolscript.toml
  start(): Promise<StartResult>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  stop(): Promise<void>;
}
```

**`start()` implementation details:**

1. **Resolve binary:** Read `process.env.TOOLSCRIPT_BIN`; fall back to `"toolscript"` (relies on `$PATH`).
2. **Resolve config files:** Check existence of `~/.pi/toolscript/toolscript.toml` (use `homedir()` from `node:os`) and `path.join(this.cwd, "toolscript.toml")` (use `node:fs` `existsSync`). If neither exists, throw an `Error` with a message like `"No toolscript config found"`.
3. **Build args:** `["run"]`, then for each config file that exists (user-level first, project-level second): `"--config", absolutePath`.
4. **Create `StdioClientTransport`:** Import from `@modelcontextprotocol/sdk/client/stdio.js`. Construct with `{ command: binary, args, cwd: this.cwd, stderr: "inherit" }`.
5. **Create `Client`:** Import from `@modelcontextprotocol/sdk/client/index.js`. Construct with `{ name: "pi-toolscript", version: "1.0.0" }`. Call `client.connect(transport)` — this spawns the child process and performs the MCP `initialize` handshake.
6. **Get instructions:** Call `client.getInstructions()` after connect. Default to `""` if undefined.
7. **List tools:** Call `client.listTools()`. Map each tool in the response to `McpToolDef`: `{ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }`.
8. **Store** the `Client` instance and transport on `this` for use in `callTool` and `stop`. Also track a `running: boolean` flag.
9. **Listen for process exit:** Register the transport's `onclose` callback to set `this.running = false`.
10. **Return** `{ tools, instructions }`.

**`callTool()` implementation details:**

1. If `this.running` is `false` (process crashed), attempt to restart: call `this.start()` internally (re-resolves config, respawns). Then return `{ content: "toolscript crashed and has been restarted. The previous call was lost — please retry.", isError: true }`.
2. If running, call `this.client.callTool({ name, arguments: args })`. Extract content: iterate over `result.content`, collect all items where `item.type === "text"`, join their `.text` with newlines. Set `isError` from `result.isError ?? false`.
3. Return `{ content, isError }`.

**`stop()` implementation details:**

1. If not running, return early.
2. Call `this.client.close()` (the MCP SDK `Protocol.close()` method, which closes the transport and kills the child process).
3. Set `this.running = false`.

**Verify:** File exists at `extensions/toolscript/client.ts`, exports `ToolscriptClient`, `McpToolDef`, `StartResult`, `CallToolResult`. The class compiles without type errors when loaded by pi's jiti runtime (verify by starting pi in a directory with a `toolscript.toml` — deferred to Step 3 integration).
**Status:** done

### Step 3: Implement extension entry point in `index.ts`

Create `extensions/toolscript/index.ts` — the default export function that wires `ToolscriptClient` into pi's lifecycle.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { ToolscriptClient } from "./client.js";
```

**Extension body:**

1. Declare `let client: ToolscriptClient | null = null` in the closure scope.

2. **`session_start` handler:**
   - Instantiate `new ToolscriptClient(ctx.cwd)` where `ctx.cwd` comes from the event handler's `ExtensionContext`.
   - Call `client.start()` in a try/catch. On error, log via `ctx.ui.notify("Toolscript not available: " + error.message, "info")` and return early (extension stays dormant — no tools registered).
   - On success, iterate over `result.tools`. For each `mcpTool`, call `pi.registerTool()` with:
     - `name`: `"toolscript_" + mcpTool.name`
     - `label`: `"Toolscript: " + mcpTool.name`
     - `description`: `mcpTool.description`
     - `promptSnippet`: `mcpTool.description`
     - `promptGuidelines`: only on the first tool (index 0 in the loop, which will be `list_apis` as it comes first from toolscript) — set to `[result.instructions]` (the full instructions string as a single guideline bullet). For other tools, omit `promptGuidelines`.
     - `parameters`: `mcpTool.inputSchema as TSchema` — MCP's inputSchema is JSON Schema, which is structurally compatible with TypeBox's TSchema at runtime.
     - `execute`: `async (_toolCallId, params) => { const r = await client!.callTool(mcpTool.name, params as Record<string, unknown>); return { content: [{ type: "text", text: r.content }], details: { isError: r.isError } }; }`
   - After registering all tools, notify: `ctx.ui.notify("Toolscript: " + result.tools.length + " tools registered", "info")`.

3. **`session_shutdown` handler:**
   - If `client` is not null, call `await client.stop()`. Set `client = null`.

**Note on `promptGuidelines` placement:** The architecture specifies guidelines only on `toolscript_list_apis`. However, toolscript's tool order from `tools/list` isn't guaranteed. Instead of hardcoding the name, attach guidelines to the first tool in the array — this is pragmatic and ensures they appear exactly once. If the tool name matters, an alternative is to find the tool named `list_apis` and attach there; use whichever approach is cleaner during implementation.

**Verify:** Start pi in a directory containing `toolscript.toml` (or with `~/.pi/toolscript/toolscript.toml` present). Confirm:
- The notification "Toolscript: N tools registered" appears.
- The tools appear in the system prompt (check via `/tools` or equivalent).
- Calling a toolscript tool (e.g., `toolscript_list_apis`) proxies to toolscript and returns results.
- Exiting pi cleanly shuts down the toolscript child process (no orphaned processes).
**Status:** not started
