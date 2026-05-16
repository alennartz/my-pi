# Manual Testing — subagent-cwd

## Smoke Suite

From `tools/manual-test/PLAN.md`:

- **J1 (subagent lifecycle — spawn, message, teardown):** directly impacted —
  this topic adds a new optional field (`cwd`) to the `subagent` tool's
  per-agent spec. The spawn path is what gates the new behavior, so J1 is
  the natural smoke target. Exercised here with both a no-cwd spawn (the
  legacy default) and a cwd-override spawn.
- **J2 (resurrect):** indirectly impacted — persistence now carries an
  optional `cwd` per record. A round-trip teardown→resurrect on an agent
  spawned with a `cwd` confirms the field flows through `PersistedAgentRecord`
  and the restored child lands in the recorded directory.
- **J3 (fork), J4 (pipeline phase), J5 (worktree):** skipped — fork is
  architecturally excluded from `cwd` (brainstorm decision), and J4/J5 are
  unrelated to this surface.

## Topic-Specific Tests

Adjacent to the focus hints (one ring outward — what triggers the new
behavior, what cleans up after it, what state it leaves behind):

- **T1: Absolute `cwd`** — spawn one subagent with an absolute path; child
  reports `pwd` matching it.
- **T2: "As if pi were freshly launched"** — child sees an `AGENTS.md`
  placed in the target directory at boot (project context discovery from
  the new cwd, not the parent's).
- **T3: Relative `cwd`** — relative path resolves against the parent's cwd.
- **T4: Invalid `cwd` — nonexistent path** — batch fails atomically; no
  agents spawn.
- **T5: Invalid `cwd` — path is a file** — same atomic batch failure.
- **T6: Mixed batch** — one agent with `cwd` override, one without; both
  spawn into the right places (parent default vs. override).
- **T7: Atomicity with valid + invalid in the same batch** — one valid cwd
  alongside one invalid one; nothing spawns, the valid one is *not*
  partially created.
- **T8: Persistence round-trip via resurrect** — spawn with cwd, tear down,
  resurrect; restored child still reports the overridden cwd.

## Tools

- Reused: `tools/manual-test/README.md` → "direct tool driver" (the
  manual-test agent calls `subagent` / `send` / `teardown` / `resurrect`
  directly; the transcript IS the log).
- New: none.
- Improved: none.

## Harness Limitations

- The driver is the in-process `subagent` tool call from this manual-test
  agent. Bugs that only surface across a full pi-process restart (parent
  killed and resumed from scratch) are **not** exercised — the plan calls
  out restore-time validation (`pruneInvalidPersistedAgents` skipping an
  agent whose cwd was deleted between sessions) as best-effort, and that
  cross-restart path is structurally outside what one parent session can
  drive. T8 covers in-process resurrect, which is the closest accessible
  proxy.
- TypeBox `additionalProperties: false` rejection of `cwd` on `fork` /
  `resurrect` cannot be exercised from this agent — the harness sends only
  schema-valid tool calls. That guard is asserted by code review, not run-
  time test.

These gaps do not weaken the topic's primary behavior (spawn-time
resolution, validation, and propagation), so no escalation is needed.

## Results

(Filled in below as each item runs.)

## Plan Updates

(Filled in at the end.)

## Open Issues

(Filled in at the end.)
