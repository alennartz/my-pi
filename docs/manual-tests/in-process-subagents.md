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
- Improved: no persistent repo tool was needed; ephemeral Node RPC drivers
  under `/tmp` parameterized the real pi process for this run and were not
  retained as one-shot tooling.

## Harness Limitations

The direct tool calls run through this pi coding-agent harness rather than a
human-operated TUI, so visual dashboard layout and keyboard-only presentation
cannot be judged. Provider-backed child prompts also depend on ambient model
availability and latency; message/status assertions are structural and may not
expose provider-specific streaming races. The resume-restore driver launches a
real top-level `pi --mode rpc` process by design to cross a restart boundary,
while fresh recursive tests use real in-process SDK child sessions. No
synthetic transport or mocked child runtime is used for the topic's primary
spawn/messaging behavior. The surrounding coding harness already owns one
`/tmp/pi-broker-*.sock`; therefore the hygiene check compares socket/PID deltas
from before each run rather than claiming that the ambient harness has no
socket at all. Child-specific cwd settings, an extension, and a skill fixture
were real files; no human TUI dashboard screenshot was available.

## Results

### Smoke Suite

- **J1 — lifecycle, status, messaging, interrupt, teardown:** Ran real
  `pi --mode rpc` sessions with `/tmp/manual-inproc-basic.mjs`,
  `/tmp/manual-inproc-messaging.mjs`, `/tmp/manual-inproc-interrupt.mjs`, and
  `/tmp/manual-inproc-recursive2.mjs`. Fresh children returned ACK/READY;
  `check_status` projected idle/running states and usage; fire-and-forget
  returned `Message sent to worker.`; blocking send returned `BLOCK-OK`;
  cooperative interrupt returned `Interrupted: worker` and left the child idle;
  recursive teardown returned an `<agent_torn_down>` report. Every run added no
  `pi` PID and no socket. **Verdict: fixed-inline.** Coherence: looks coherent
  — statuses, notifications, and teardown reports form one consistent
  parent-local flow. Fixes were localized: restored missing `summarizeArgs`
  (`21db693`), ignored stale SDK conflict diagnostics for the filtered root
  extension (`7a05fd7`), and prevented recursive registry disposal deadlock
  (`dd6868e`).
- **J2 — resurrection:** Ran `/tmp/manual-inproc-resurrect2.mjs` with a real
  project persona (`tools: bash, send`). Teardown surfaced a session ID;
  resurrection reopened it as `revived`, preserved `Agent definition:
  manual-persona`, executed the persona's bash tool, and returned
  `RESURRECTED`; final teardown completed. **Verdict: pass.** Coherence: looks
  coherent — the report's session ID leads to the same conversation and
  capability boundary.
- **J3 — fork:** First run exposed a failed fork when session-resume's pending
  source turn raced the initial fork task. The child JSONL showed a
  `session-resumed` continuation and no task turn. After queueing fork tasks as
  `followUp` (`3cd1ade`), rerun produced idle `forked` with Last output
  `FORKED`, then teardown and clean shutdown. The non-fork submit mock
  assertion was updated to preserve the existing call shape (`34af8b8`,
  `08b57a4`). **Verdict: fixed-inline.**
  Coherence: looks coherent — the fork now completes independently while the
  parent remains available.
- **J6 — parent resume/restore:** Ran
  `PI_CODING_AGENT_DIR=<temp current-repo settings> node
  tools/manual-test/resume-restore/run.mjs --timeout 180 --keep` and the same
  command with `--nested`. Both returned `PASS`; restored status was idle and
  model, last output, input/output usage, turns, and cost matched the
  independent child-session oracle. Nested mode also matched
  `subgroupInput=true`. **Verdict: pass.** Coherence: looks coherent — the
  dashboard-facing status agrees with the persisted child transcript after a
  restart.

### Topic-Specific Tests

- **Fresh in-process ownership and immediate-child projection:** Covered by
  the basic lifecycle run; the parent persistence log recorded the child and
  `check_status` showed its idle state/last output. **Verdict: pass.**
  Coherence: looks coherent.
- **Fire-and-forget and blocking messaging:** The messaging run observed both
  `Message sent to worker.` and the synchronous `BLOCK-OK` response, with no
  extension errors. **Verdict: pass.** Coherence: looks coherent.
- **Recursive parent-local routers and canonical paths:** The researcher →
  scout run created nested lifecycle logs and a child session named
  `researcher/scout`; helper output completed, parent status showed the active
  subgroup, and recursive teardown removed the subtree. **Verdict: fixed-inline**
  (diagnostic/deadlock fixes above). Coherence: looks coherent.
- **Cooperative interrupt:** A child forced to run `bash sleep 30` was
  interrupted without failure; status was idle and teardown was clean.
  **Verdict: pass.** Coherence: looks coherent.
- **Teardown/resurrection:** Covered by J2, including persisted session ID and
  resumed persona/tool policy. **Verdict: pass.** Coherence: looks coherent.
- **Legacy persisted-session reopening:** Created an ordinary version-3 JSONL
  child with legacy session-info naming plus a version-1 lifecycle log, then
  resumed the real parent. The in-process path reopened the exact child file,
  retained its session ID/cwd/history, and projected an idle status before
  teardown. The SDK's normal `session-resume` hook then appended a continuation
  turn, so later status usage/output included that resumed work. **Verdict:
  pass.** Coherence: looks coherent — legacy history remains usable and the
  automatic continuation is visible rather than silently discarded.
- **Isolated cwd/tools/skills/extensions:** A child-specific cwd contained a
  real `child_probe` extension and `child-skill`; the child session header used
  that cwd, invoked `child_probe`, and returned both `CHILD_PROBE_OK` and the
  skill marker `CHILD_SKILL_OK`. The parent cwd had neither resource. **Verdict:
  pass.** Coherence: looks coherent.
- **Absence of child pi processes/socket brokers and shutdown hygiene:** Each
  real in-process run compared `pi-ps` and `/tmp/*.sock` before/after; only the
  existing parent harness process/socket remained, with zero child PID/socket
  delta. Registry teardown and final process shutdown left no new transport
  artifact. **Verdict: pass.** Coherence: looks coherent, subject to the
  ambient-socket limitation documented above.

## Plan Updates

Empty — the persistent primary journeys were unchanged.

## Open Issues

Empty — all observed product failures were localized and fixed inline.


