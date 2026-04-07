# Brainstorm: Toolscript Pi Extension

## The Idea

Build a pi extension that integrates [toolscript](https://github.com/user/toolscript) — a Rust tool that transforms OpenAPI specs and MCP servers into a scriptable Luau SDK runtime. The extension spawns toolscript as a long-lived child process and surfaces its capabilities as pi tools, giving pi's models access to arbitrary APIs and MCP servers through toolscript's scripting layer.

## Context

- **Toolscript** generates a Luau SDK from OpenAPI specs and/or upstream MCP servers, then serves it via MCP protocol. LLMs discover APIs through documentation tools, then write Luau scripts that chain multiple API calls in a single execution — one round-trip instead of many.
- **Pi has no built-in MCP support** by design. Extensions are the intended integration path.
- Toolscript exposes 5 MCP tools: `list_apis`, `list_functions`, `get_function_docs`, `search_docs`, `execute_script`.
- Toolscript also exposes MCP resources (`sdk://` URIs) but these duplicate the tool functionality — only the tools need to be surfaced in pi.
- Toolscript supports stdio and HTTP/SSE transports for MCP.
- Toolscript accepts multiple `--config` flags with later files overriding earlier ones, enabling layered configuration.

## Key Decisions

### Long-lived process, not CLI-per-call
**Decision:** Spawn toolscript as a persistent child process rather than invoking it per tool call.
**Why:** Toolscript maintains meaningful state — upstream MCP server connections (child processes, persistent HTTP connections) and a pre-built annotation cache. Rebuilding per invocation would be slow and wasteful. Toolscript is architecturally a server, not a CLI tool.

### Stdio transport
**Decision:** Use MCP over stdio (JSON-RPC over stdin/stdout) rather than HTTP/SSE.
**Why:** Simpler lifecycle management — the extension spawns the child process and owns it. No port allocation, no auth, clean shutdown (kill child on exit). Natural fit for a pi extension managing a subprocess.

### @modelcontextprotocol/sdk, not hand-rolled
**Decision:** Use the official `@modelcontextprotocol/sdk` npm package for the MCP client.
**Why:** It handles `initialize`, `tools/list`, `tools/call`, and JSON-RPC framing over stdio. The protocol surface is small but there's no reason to reimplement what a maintained library already provides.

### Toolscript-specific, not a generic MCP bridge
**Decision:** This extension is specifically for toolscript, not a generic "connect to any MCP server" bridge.
**Why:** Toolscript itself is the bridge to other MCP servers and OpenAPI specs. The extension doesn't need to generalize — toolscript handles the fan-out. This keeps the extension focused and simple.

### Layered configuration: project + user
**Decision:** Look for `./toolscript.toml` (project-level) and `~/.pi/toolscript/toolscript.toml` (user-level). If both exist, pass both via `--config` with user-level first and project-level second (project overrides user). If only one exists, pass just that one. If neither exists, don't start toolscript.
**Why:** Project-level config is the natural default (matches `toolscript run` behavior). User-level provides a base layer for common APIs and auth that apply across projects. The user-level path lives under `~/.pi/` rather than `~/.config/toolscript/` because this fallback mechanism is a pi extension design choice, not a toolscript convention.

### Eager startup
**Decision:** Start toolscript on `session_start` (if at least one config file exists).
**Why:** If the config exists, you probably intend to use the tools. Eager start avoids surprising latency on the first tool call. Toolscript's `run` subcommand handles SDK generation and serving in one step — the first run per config is slower (parsing specs, building annotation cache), but this cost is paid at session start rather than mid-conversation.

### Binary discovery: env var with PATH fallback
**Decision:** Use `TOOLSCRIPT_BIN` env var if set, otherwise look for `toolscript` on `$PATH`.
**Why:** Works naturally with `cargo install`. The env var covers non-standard locations or development builds without complicating the common case.

### Crash recovery: restart and surface error
**Decision:** When toolscript crashes mid-session, auto-restart the process and return an error to the model so it knows what happened. Don't silently retry the failed call.
**Why:** The script that crashed might have been the cause, so blindly retrying could loop. But the process should come back up for the next attempt. The model can decide whether to retry or adjust.

### Tools namespaced under toolscript_*
**Decision:** Register all 5 MCP tools as pi tools with `toolscript_` prefix: `toolscript_list_apis`, `toolscript_list_functions`, `toolscript_get_function_docs`, `toolscript_search_docs`, `toolscript_execute_script`.
**Why:** Namespacing makes it clear to the model that these tools belong together as a coherent workflow. Tool descriptions come directly from toolscript's MCP `tools/list` response — they're already well-written for LLM consumption.

### Prompt guidelines from toolscript's instructions
**Decision:** Use toolscript's `initialize` response `instructions` field as `promptGuidelines` content. This field already describes the workflow (discover → browse → write → execute) and lists the loaded APIs/MCP servers.
**Why:** Toolscript already generates good LLM-facing instructions from the loaded manifest. No need to duplicate or rewrite them. They update naturally on `/reload` when the config changes.

## Direction

A pi extension in `extensions/toolscript/` that:
1. On `session_start`, checks for config files (`./toolscript.toml` and `~/.pi/toolscript/toolscript.toml`)
2. If at least one exists, spawns `toolscript run --config <files...>` as a child process on stdio
3. Connects via `@modelcontextprotocol/sdk` as an MCP client
4. Calls `initialize` and `tools/list` to discover tool definitions
5. Registers 5 pi tools (`toolscript_*`) with descriptions from the MCP response
6. Sets `promptGuidelines` from the `initialize` instructions field
7. Proxies tool calls through to toolscript via `tools/call`
8. On crash: restarts the process, surfaces error to model
9. On `session_shutdown`: kills the child process

## Open Questions

None — all questions from the initial brainstorm have been resolved.
