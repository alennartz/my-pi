# DR-040: Quota enforcement returns `handled` and notifies rather than throwing from the input handler

## Status
Accepted

## Context
Pi's extension runner catches and silently discards all throws from `input` (and `before_agent_start`) handlers — the RPC `prompt` command reports success regardless, so a throw cannot block a prompt. This was discovered while examining `dist/core/extensions/runner.js` during implementation planning for the quota-providers extension. The natural implementation (throw an error to block) would silently fail to block anything.

## Decision
The `input` handler returns `{ action: "handled" }` to refuse the prompt, and separately calls `ctx.ui.notify(message, "error")` for the explanation. In RPC (subagent) mode, the error notify reaches the parent's `RpcChild` event stream as an `extension_ui_request` with `notifyType: "error"` — making the block observable to the generic subagents failure-settling fix (see DR-041) without any quota-specific coupling.

## Consequences
Extensions that need to block prompts must use this pattern rather than throw. The error notify doubles as both the user-facing explanation and the parent-observable signal in RPC mode. Future extension authors who reach for `throw` in an `input` handler will silently fail to block anything — this non-obvious constraint is not surfaced by pi's API.
