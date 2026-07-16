# Manual Testing — in-process-subagents

## Smoke Suite

This run exercises the in-process subagent journeys that are in scope for the
plan and focus hints:

- **J1 — Subagent lifecycle:** fresh spawn, immediate-child status/dashboard,
  fire-and-forget and blocking messages, cooperative interrupt, and teardown.
  This is the primary migration journey because it replaces the old child pi
  process and socket transport.
- **J2 — Subagent resurrect:** teardown followed by resurrection from the
  surfaced session ID, including conversation and capability continuity.
- **J3 — Fork:** parent-context cloning and independent child completion.
- **J6 — Parent session resume:** persisted child reopening and faithful status
  recomputation after restart, using the existing real-RPC driver.

The other persistent journeys (workflow phase, worktree, model tiers) are not
part of this topic's in-process runtime migration and are left for their own
runs.

## Topic-Specific Tests

- **Fresh in-process ownership:** spawn a child and verify it appears as an
  immediate child with a canonical path, status, and completion report; inspect
  process listings and filesystem sockets for absence of child pi processes or
  broker sockets.
- **Messaging:** send fire-and-forget and blocking messages in both directions,
  including recursive parent-local routing and correlation completion.
- **Recursive spawn:** child creates a grandchild; verify parent-local routers,
  canonical nested paths, and independent sibling identity.
- **Cooperative interrupt:** interrupt a running child and verify it settles
  without process-signal escalation or a failed status.
- **Teardown/resurrection:** remove a child, resurrect it from its persisted
  session ID, and verify the restored child can continue using its original
  persona/tool restrictions.
- **Legacy persisted session:** reopen a version-1/RPC-era child JSONL session
  directly through the in-process path and verify usable history and status.
- **Isolation:** exercise child-specific cwd, skills, tools, and extension
  discovery/trust so one child cannot widen or leak another child's runtime.
- **Shutdown hygiene:** verify no child pi process, Unix socket broker, or
  stale transport artifacts remain after teardown and session shutdown.

## Tools

- Reused: direct `subagent`, `fork`, `send`, `teardown`, `resurrect`,
  `await_agents`, and `interrupt` tool driver from the parent pi harness;
  `tools/manual-test/resume-restore/run.mjs` for the cross-restart journey.
- New: none.
- Improved: none.

## Harness Limitations

The direct tool calls run through this pi coding-agent harness rather than a
human-operated TUI, so visual dashboard layout and keyboard-only presentation
cannot be judged. Provider-backed child prompts also depend on ambient model
availability and latency; message/status assertions are structural and may not
expose provider-specific streaming races. The resume-restore driver launches a
real top-level `pi --mode rpc` process by design to cross a restart boundary,
while fresh recursive tests use the in-process subagent tool surface. No
synthetic transport or mocked child runtime is used for the topic's primary
spawn/messaging behavior.

## Results

_To be filled after execution._

## Plan Updates

Empty — the persistent primary journeys already cover this topic.

## Open Issues

_To be filled after execution._
