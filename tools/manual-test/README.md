# Manual Test Tools

Index of bespoke, reusable manual-test tooling for this repo. Tools are
parameterized — no one-shot scripts hard-coded to a single topic. Add new
tools as `tools/manual-test/<tool-name>/` (or single file if trivial) and
register them here.

## Conventions

- Tools live under `tools/manual-test/`.
- Each tool has a short README or top-of-file docstring (purpose, inputs,
  outputs, prerequisites).
- Per-topic results live in `docs/manual-tests/<topic>.md`, not here.
- Persistent journeys live in `tools/manual-test/PLAN.md`, not here.

## Tools

### Direct tool driver (no separate file)

**Purpose:** Drive the subagents extension's tool surface
(`subagent`, `fork`, `send`, `teardown`, `resurrect`, `await_agents`,
`interrupt`) from the parent pi process that has this repo loaded as a pi
package. Works because the parent agent already has the tools registered.

**Invocation:** Inside a pi session where this package is installed (or run
from the repo root with the local package surfaced via `.pi/settings.json`),
the manual-test agent simply calls the tools as it normally would. The
parent's transcript captures the system's responses (XML completion
reports, error messages) verbatim — that transcript IS the test log.

**Inputs:** tool calls and their arguments.

**Outputs:** XML envelopes (`<agent_idle>`, `<group_complete>`,
`<agent_message>`), tool-error strings, and side effects observable via
`check_status`.

**Prerequisites:** A pi process with the subagents extension loaded
(automatic when this package is the active pi package).

**Use for:** any topic that touches subagent lifecycle (spawn, message,
teardown, resurrect, fork, await, interrupt). Limitations: only exercises
the in-process path; cross-restart resurrection (parent torn down and
resumed) is structurally outside what one parent session can drive — that
class of bug needs a separate harness.
