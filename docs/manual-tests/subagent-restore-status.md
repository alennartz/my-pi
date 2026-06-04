# Manual Testing — subagent-restore-status

## Smoke Suite

Exercised this run (subset of `tools/manual-test/PLAN.md`):

- **J1 — Subagent lifecycle (spawn + idle).** The restore journey's precondition:
  a real parent must first spawn a subagent and let it idle, producing the
  persistence log + child session file that restore reads. Smoked inherently by
  the resume-restore harness's setup phase.
- **J6 — Parent session resume restores subagents with faithful status (new this
  run; promoted to `PLAN.md`).** The topic's own primary journey.

J2 (resurrect), J3 (fork), J4 (pipeline phase), J5 (worktree) are out of scope for
this topic and have TBD/lifecycle drivers; not exercised this run beyond J1 setup.

## Topic-Specific Tests

The plan recomputes restored subagent status from the child's session file instead
of seeding `running`/zeroed. End-to-end behaviors specific to this topic:

- **T1 — Restored agent shows `state: idle`, not stuck `running`.** An idle-at-
  shutdown child must come back idle. This is the headline regression the topic
  fixes.
- **T2 — Usage / cost / turns / model / lastOutput are recomputed from the child
  session file**, not zeroed. Verified through the `check_status` surface (one of
  the three status-facing surfaces named in the plan).
- **T3 — `hasSubgroup` is recomputed** from the child's own `agents.jsonl` via
  `childHasLiveSubagents`. A child that itself spawned a subagent must restore with
  the subgroup flag set; a leaf child must restore with it clear.
- **Adjacent (one ring out from the focus hint):**
  - **T4 — Trigger gating.** Restore must NOT fire on `reason: "new"` / `"fork"`
    (only genuine resumes inherit prior agents) — verified by inspecting the
    `session_start` gate and a fresh-session control.
  - **T5 — Residual state correctly empty.** Broker-only fields
    (`pendingCorrelations`, `waitingFor`, `lastActivity`) are correctly empty on a
    restored agent (transient — gone on restart by design).

## Tools

- Reused: Direct tool driver (parent-IS-harness) — for the J1 spawn leg only.
- New: `tools/manual-test/resume-restore/` — drives a real parent `pi --mode rpc`
  through spawn → idle → kill → resume, then reads restored status via
  `check_status`. See its README.
- Improved: `tools/manual-test/README.md` updated to register the new tool and to
  note that cross-restart resume is now covered (was previously called out as a
  structural gap).

## Harness Limitations

- **Real LLM, real pi.** The harness drives genuine `pi --mode rpc` processes and
  real model turns — nothing about the restore path is stubbed. Cost is a few
  cheap turns per run; transient provider latency is absorbed by idle-boundary
  re-drives.
- **`hasSubgroup` rendering not RPC-observable.** The restored status is read via
  the `check_status` tool, which surfaces state/model/lastOutput/usage/turns but
  not the `hasSubgroup` boolean (that flag only appears on the widget/panel card,
  rendered by a TUI component factory that RPC mode ignores). The harness
  therefore verifies the flag's recompute *input* — the worker's own
  `agents.jsonl` log that `childHasLiveSubagents` reads — but not its rendered
  output. Weakened test: none of the topic's *primary* status fields depend on
  this gap; `hasSubgroup`'s wiring is a one-line field copy verified by code
  review (DR/review approved) and its input is exercised end-to-end here.
- **Trigger gating (T4) is code-verified, not separately driven.** The
  `reason: "new"/"fork"` suppression is a 2-line guard in `session_start`;
  exercising it would require constructing a resume-with-fresh-reason scenario
  that has no persistence to inherit anyway. Confirmed by inspection plus the
  fact that every fresh spawn-phase parent (`reason: startup`) correctly starts
  with no pre-existing agents.

None of these gaps blind the harness to the topic's primary behavior (faithful
recomputed status on resume), so no escalation was needed.

## Results

### Smoke Suite

- **J1 — Subagent lifecycle (spawn + idle):** PASS. Every harness run's spawn
  phase spawns a real `worker` subagent via the `subagent` tool, it completes a
  turn and idles, and the persistence log + child session file land as expected.
- **J6 — Parent session resume restores subagents with faithful status:** PASS.
  Leaf run verdict PASS on all 8 checks; nested run verdict PASS on all 8 checks.
  Coherence: **looks coherent** — the restored `check_status` detail reads exactly
  as a human would expect for a finished agent (idle, model, last output, usage
  with turn count), with no stale "running" or zeroed fields.

### Topic-Specific Tests

- **T1 — Restored agent shows `state: idle`, not stuck `running`:** PASS.
  `check_status` after resume reported `State: idle` in both runs. The auto-resume
  turn (parent continuing its original task) tried `teardown` and was correctly
  blocked by the tool restriction, leaving the restored agent observable.
- **T2 — Usage/cost/turns/model/lastOutput recomputed from the child session
  file:** PASS. Restored values matched an independent re-parse ("oracle") of the
  worker session exactly — leaf: `↑14096 ↓5 $0.0705 (1 turn)`, model
  `claude-opus-4-8`, lastOutput `ACK`; nested: `↑53055 ↓189 $0.1492 (4 turns)`,
  lastOutput recomputed to the worker's final message. `inputUsageMatchesOracle`,
  `outputUsageMatchesOracle`, `turnsRecomputed`, `modelRecomputed`,
  `lastOutputRecomputed`, `costRecomputed` all true.
- **T3 — `hasSubgroup` recompute input present:** PASS. In `--nested` mode the
  restored worker's own `agents.jsonl` contained its `helper` subagent
  (`subgroupInput: true`); in the leaf run it was absent (`false`). Confirms the
  input `childHasLiveSubagents` recomputes from is faithful after restore. (Flag
  rendering itself not RPC-observable — see Harness Limitations.)
- **T4 — Restore gated to genuine resumes (`new`/`fork` excluded):** PASS
  (code-verified). The `session_start` handler returns before restore on
  `reason: "new"/"fork"`; resumes use `reason: "startup"`/`"resume"`. A probe
  confirmed resume fires with `reason: "startup"` and the gate lets it through.
- **T5 — Residual broker state correctly empty:** PASS. The restored
  `check_status` detail showed no "Pending correlations" line and no "Last
  activity" line — `pendingCorrelations`, `waitingFor`, and `lastActivity` are
  empty on the restored agent, as designed (transient broker state, gone on
  restart).

### Fixed inline

None — all checks passed as built; no product changes were required.

### Notable harness finding (not a product bug)

The first harness drafts failed to restore because the spawned pi processes
inherited `PI_PARENT_LINK` from the enclosing pi subagent, making them believe
they were child agents (the `parentLink` guard short-circuits restore). The
harness now scrubs `PI_PARENT_LINK`/`PI_CODING_AGENT`. This is purely a test-rig
concern — it does **not** affect real pi restarts, where a top-level resume has
no `PI_PARENT_LINK`.

## Plan Updates

- **Added J6** to `tools/manual-test/PLAN.md`: "Parent session resume restores
  subagents with faithful status." This is a genuine new primary journey — the
  resume path is exercised on every real-world pi restart that had live subagents,
  and silent status corruption there is a high-value regression.

## Open Issues

None. All Smoke Suite and Topic-Specific Tests passed; no escalations, no
ambiguous findings, no user-decision items.
