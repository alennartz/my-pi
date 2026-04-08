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
