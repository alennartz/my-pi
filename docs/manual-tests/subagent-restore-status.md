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

Populated in "Assess Harness Limitations" below before execution.

## Results

Populated during execution.

## Plan Updates

- **Added J6** to `tools/manual-test/PLAN.md`: "Parent session resume restores
  subagents with faithful status." This is a genuine new primary journey — the
  resume path is exercised on every real-world pi restart that had live subagents,
  and silent status corruption there is a high-value regression.

## Open Issues

Populated during execution.
