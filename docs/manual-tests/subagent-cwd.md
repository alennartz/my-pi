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

### Smoke Suite

- **J1 (spawn / message / teardown)** — exercised via T1 (cwd override
  branch) and T6's `t6-default` (no-cwd legacy branch). Both spawned,
  produced their `agent_idle` reports with `pwd` output, and tore down
  cleanly via `teardown`. **Verdict: pass.** Coherence: looks coherent —
  the no-cwd child reports the parent's cwd; the override child reports
  its target dir; teardown surfaces `<agent_torn_down>` with a usable
  `session_id`, exactly as documented.
- **J2 (resurrect)** — exercised via T8 below. **Verdict: pass.**
  Coherence: looks coherent — the resurrected child lands in the
  recorded cwd without any re-spec from the caller.

### Topic-Specific Tests

- **T1 (absolute `cwd`)** — spawned `t1-abs` with
  `cwd: "/tmp/subagent-cwd-fixtures/proj-a"`. Child's `pwd` reported
  `/tmp/subagent-cwd-fixtures/proj-a`. **Verdict: pass.** Coherence:
  looks coherent.
- **T2 ("as if pi were freshly launched")** — same spawn as T1; child
  also `head -1 AGENTS.md` and reported `SENTINEL-A: this is the
  AGENTS.md for project A …`, i.e. the file inside the target cwd, not
  the repo's own AGENTS.md. **Verdict: pass.** Coherence: looks
  coherent — the project-context discovery did re-root at the new cwd.
- **T3 (relative `cwd`)** — spawned `t3-rel` with `cwd:
  "extensions/subagents"` from parent cwd `/home/alenna/repos/my-pi`.
  Child's `pwd` reported `/home/alenna/repos/my-pi/extensions/subagents`.
  Reinforced by `t-rel-bad`: a deliberately broken relative path
  produced an error message naming the *resolved absolute* path
  (`/home/alenna/repos/my-pi/no/such/relative/dir`), not the relative
  input — confirms `path.resolve(parentCwd, …)` runs before validation.
  **Verdict: pass.**
- **T4 (invalid `cwd` — nonexistent path)** — spawn of `t4-bad` with
  `cwd: "/tmp/subagent-cwd-fixtures/does-not-exist-xyz"` returned a tool
  error: `Agent "t4-bad" has invalid cwd: "/tmp/subagent-cwd-fixtures/
  does-not-exist-xyz" does not exist or is not a directory`. `check_status`
  afterward reported no agents running. **Verdict: pass.** Coherence:
  looks coherent — message identifies the agent id and the path that
  failed; the atomic-batch promise holds.
- **T5 (invalid `cwd` — path is a file)** — spawn of `t5-file` with
  `cwd: "/tmp/subagent-cwd-fixtures/not-a-dir.txt"` returned the same
  error shape (`does not exist or is not a directory`), confirming the
  validator distinguishes file vs. directory via `stat.isDirectory()`.
  **Verdict: pass.**
- **T6 (mixed batch)** — single `subagent` call with three specs:
  `t3-rel` (relative `cwd`), `t6-default` (no `cwd`), `t6-override`
  (absolute `cwd`). All three spawned. Their `pwd` outputs matched
  expectations exactly: parent cwd for the no-`cwd` child, resolved
  override for the other two. **Verdict: pass.** Coherence: looks
  coherent — the per-spec selection (`agentSpec.cwd ?? this.opts.cwd`)
  routes each child independently with no cross-contamination.
- **T7 (atomicity with valid + invalid)** — single `subagent` call with
  `t7-valid` (valid absolute `cwd`) and `t7-invalid` (nonexistent
  `cwd`). Tool error mentioned only the invalid spec; `check_status`
  afterward reported no agents running, confirming the valid sibling was
  not partially spawned. **Verdict: pass.** Coherence: looks coherent —
  matches `resolveAgentCwds`'s synchronous-throw contract.
- **T8 (persistence round-trip via resurrect)** — `t1-abs` torn down
  produced `<agent_torn_down session_id="019e3163-…"/>`. Resurrected
  as `t1-resurrected` with that session_id and a fresh task; child's
  `pwd` still reported `/tmp/subagent-cwd-fixtures/proj-a`. **Verdict:
  pass.** Coherence: looks coherent — confirms the persistence path
  (`AgentEntry.cwd → PersistedAgentRecord.cwd → toRestoreSpec`) round-
  trips intact and the restored child is rebooted in the recorded cwd.

## Plan Updates

None. The persistent journeys in `tools/manual-test/PLAN.md` are
unchanged — `cwd` is an additive optional parameter on J1's existing
spawn surface, not a new primary journey. J1's description already covers
"spawn one or more child agents via the `subagent` tool"; no rewrite is
warranted.

## Open Issues

None. Every smoke and topic-specific test passed; no items were fixed
inline (because nothing was broken); no escalations.
