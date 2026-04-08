# Review: Toolscript Extension

**Plan:** `docs/plans/toolscript-extension.md`
**Diff range:** `2e510ed146e555047d98e93371b1dad531873f09..a08082aa87cea46bb9fde6ed2244730d8423af46`
**Date:** 2026-04-08

## Summary

The plan was implemented faithfully — all three steps are complete with no meaningful deviations from the architecture or interfaces. Two code correctness concerns were identified: a race condition in concurrent crash-restart scenarios, and unhandled exceptions from the MCP `callTool` RPC that bypass the structured error path.

## Findings

### 1. Concurrent crash-restart race in `callTool`

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/toolscript/client.ts:89-96`
- **Status:** resolved

If the toolscript process has crashed (`this.running === false`) and the LLM issues two parallel tool calls, both enter `callTool`, both see `!this.running`, and both call `await this.start()`. Since `start()` yields at multiple `await` points (`connect`, `listTools`), both execute concurrently — each spawning a child process and overwriting `this.client` / `this.transport`. One child process is leaked (no reference, never closed). A guard (e.g., storing the restart promise and deduplicating) would prevent this.

### 2. Unhandled exception from MCP `callTool` RPC

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/toolscript/client.ts:98`
- **Status:** resolved

If the MCP `callTool` RPC throws (transport dies mid-call, protocol error, timeout), the exception propagates uncaught through the `execute` handler in `index.ts:33`. The code already has a graceful error pattern for the crash-restart case, but the happy-path call has no `try/catch`. This means a transport failure during a call produces an unstructured framework-level error instead of the structured `{ isError: true, content: "..." }` response. Wrapping the call in a try/catch and returning a structured error would make this resilient.

## No Issues

Plan adherence: no significant deviations found. The implementation is a faithful execution of all three plan steps. The one minor ordering difference (`transport.onclose` registered before `client.connect` rather than after) is a correct adaptation that eliminates a race window.
