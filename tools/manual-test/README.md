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
the in-process path. Cross-restart resume (parent killed and resumed) is now
covered by the `resume-restore` tool below.

### resume-restore (`resume-restore/run.mjs`)

**Purpose:** Drive a real `pi --mode rpc` parent through the full
spawn → idle → kill → resume journey and assert that restored subagent status
is faithful (`state: idle` not stuck `running`; usage/cost/turns/model/
lastOutput recomputed from the child session file; `hasSubgroup` recompute
input present). This is the cross-restart path the in-process direct driver
structurally cannot reach.

**Invocation:** `node tools/manual-test/resume-restore/run.mjs [--nested] [--keep] [--model <id>] [--workdir <dir>] [--timeout <sec>]`. See `resume-restore/README.md`.

**Inputs:** flags only; uses ambient pi provider config.

**Outputs:** phase log on stderr; JSON verdict on stdout
(`{verdict, checks, observed, expected}`); exit 0 = PASS, 1 = FAIL.

**Prerequisites:** `pi` on PATH with this package loaded. Scrubs
`PI_PARENT_LINK`/`PI_CODING_AGENT` from the spawned pi env (critical when run
inside a pi subagent, or restore is skipped).

**Use for:** any topic touching subagent persistence/restore on session resume.
Limitations: observes status via `check_status` (the `hasSubgroup` widget/panel
rendering is a TUI component factory RPC ignores — only its recompute input is
verified); drives a real LLM, so it costs tokens and tolerates transient
latency.
