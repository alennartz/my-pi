# Manual Testing — subagent-resurrect

## Smoke Suite

This run exercises only the journeys directly relevant to the topic. J1
(subagent lifecycle) is implicitly covered by every test below — every
resurrect test starts by spawning and tearing down. J3/J4/J5 are out of
scope for this topic and not driven this run.

- **J1: Subagent lifecycle — spawn, message, teardown.** Implicitly covered
  by the resurrect tests' setup phases. Verifies that XML teardown reports
  carry the new `session_id` attribute and `<hint>` element added by this
  topic.
- **J2: Subagent resurrect.** Topic's own journey — covered exhaustively
  below.

## Topic-Specific Tests

Per the focus hints in the spawn message:

- **T1: Happy path.** Spawn → teardown → resurrect from session_id →
  resurrected agent recalls something said before teardown.
- **T2: Error — unknown session_id.** Resurrect with a UUID that no session
  file matches.
- **T3: Error — session_id held by a live agent.** Spawn agent A, attempt
  to resurrect A's session_id while A is still live.
- **T4: Error — agent id collision.** Resurrect using an `id` that is
  already in use by a live agent.
- **T5: Error — no prior subagents at all.** This run cannot exercise the
  literal "no subagent infrastructure for this parent session" path,
  because the parent session reaching this skill has already spawned at
  least one subagent (this very test agent). Recorded as a harness
  limitation; structural coverage in `extensions/subagents/messages.test.ts`
  and the implementation gating in `index.ts` is relied on instead.
- **T6: Persona/tool-set inheritance.** Spawn a `scout` (read-only persona)
  → teardown → resurrect → ask the resurrected agent to inspect its tool
  surface and verify it does NOT have `write`/`edit`/`bash`. This is the
  finding from `docs/reviews/subagent-resurrect.md` §1 (resolved); manual
  test confirms the fix landed.
- **T7: Teardown XML shape.** Spot-check a single-agent teardown and a
  group teardown: each `<agent_idle>`/`<agent>` carries `session_id`, and
  exactly one `<hint>` child appears per teardown envelope.

## Tools

- Reused: direct tool driver (`tools/manual-test/README.md`). The parent
  agent (this skill's runtime) has `subagent`, `teardown`, `resurrect`,
  `send`, `await_agents`, `check_status` registered, so test execution is
  literal tool invocation.
- New: none.
- Improved: none.

## Harness Limitations

- **Cross-restart resurrection is not exercised.** The plan calls out that
  resurrect must work after a fresh pi process resumes the parent session.
  A single-process manual-test agent cannot self-restart, so this test
  category is structurally invisible here. Class of bug missed: parent-
  process state assumptions that survive in-memory but break across
  serialization (e.g. session-dir handles, lazy-init ordering when
  `resurrect` is the very first subagent op of a resumed parent). Topic's
  primary user-visible behavior (T1–T7) is observable in-process.
- **"No prior subagents at all" error path (T5).** The parent reaching this
  skill has already spawned subagents (this one). Cannot reproduce the
  literal first-ever-resurrect-with-no-sessions-dir condition without a
  fresh parent. Falls back to code-path inspection.
- The driver runs as a child of the parent pi process; its session
  directory is the same one the resurrect tool resolves against. This is
  representative of the real flow.

## Results

All tests run via direct tool invocation from this manual-test agent (the
parent pi process with the subagents extension loaded). Transcript excerpts
below are verbatim — they ARE the test log.

### J1 (implicit) — subagent lifecycle

Spawn → natural completion → teardown worked across both default and
`scout` personas. Natural-idle notifications use the broker path and do not
carry `session_id` (by design); the teardown XML does. **Verdict: pass.**

### T1 — happy-path resurrect with conversation recall

- Spawn `t1-agent` with task asking it to remember `PURPLE_TURTLE_42_MARMALADE`.
- Teardown surfaced `session_id="019de973-3147-7259-a784-7822d5228d34"`.
- `resurrect(id="t1-revived", sessionId=...)` succeeded.
- Resurrected agent replied with the exact phrase: `PURPLE_TURTLE_42_MARMALADE`.
- **Verdict: pass.** Conversation history is fully preserved across teardown→resurrect.
- **Coherence:** looks coherent. Resurrected agent answered in-context as if
  no teardown had occurred.

### T2 — error: unknown session_id

- `resurrect(sessionId="deadbeef-dead-beef-dead-beefdeadbeef")` →
  `<error>No session found with id deadbeef-dead-beef-dead-beefdeadbeef.</error>`
- **Verdict: pass.** Matches Architecture/Errors string exactly.

### T3 — error: session_id held by live agent

- With `t1-revived` live and holding `019de973-...`, attempted
  `resurrect(id="t3-double", sessionId="019de973-...")`.
- Got: `Session 019de973-3147-7259-a784-7822d5228d34 is currently held by
  live agent t1-revived; teardown that agent first or use a different one.`
- **Verdict: pass.** Matches the documented string verbatim.

### T4 — error: agent id collision

- With `t1-revived` live, attempted
  `resurrect(id="t1-revived", sessionId=<bogus uuid>)`.
- Got: `Agent id "t1-revived" already exists`.
- **Verdict: pass.** Matches Step 5's wording (Architecture's alternate
  phrasing was a draft; Step 5 is the canonical one and ships).
- **Order check:** id-collision check fires before session-resolution, as
  the plan specifies (the bogus session_id never got far enough to error).

### T5 — error: no prior subagents at all

- **Not exercised this run.** The parent reaching this skill has already
  spawned subagents (this very manual-test agent), so `childSessionsDir`
  exists. Falls back to code-path inspection: `index.ts` checks
  `fs.existsSync(...)` after `resolveSessionFile` returns undefined and
  throws `"No subagent infrastructure for this parent session — nothing to
  resurrect."` — see plan Step 5.4.
- **Verdict: open (not run).** Logged in *Harness Limitations* and *Open
  Issues* — no fix needed; structurally outside what one parent session
  can drive.

### T6 — persona/tool-set inheritance (review finding §1)

- Spawn `t6-scout` (agent `scout`, persona tools: `read, bash, send`).
  Stored codeword `SCOUT_BLUE_HORIZON_77`.
- Teardown surfaced `session_id="019de974-776e-73d9-b61d-1ef1ec488ca2"`.
- Resurrected as `t6-scout-revived`, asked to (a) recall codeword and
  (b) enumerate available tools.
- Reply:
  ```
  CODEWORD: SCOUT_BLUE_HORIZON_77
  TOOLS:
  read
  bash
  send
  respond
  user_edit
  ```
- **Verdict: pass.** Codeword recalled; tool surface remains restricted to
  the persona's allowed set plus the always-on `respond` peer of `send`
  and the `user_edit` extension tool (which is also present on a
  freshly-spawned scout, not introduced by resurrect). Notably **absent**:
  `write`, `edit`, `subagent`, `fork`, `teardown`, `resurrect`,
  `await_agents`, `check_status`, `interrupt`. The capability-escalation
  bug from review §1 is fixed and the fix survives end-to-end.
- **Coherence:** looks coherent. The resurrected scout behaved as a scout —
  did not attempt to spawn anything, did not try to edit files, just
  answered the two questions.

### T7 — teardown report XML shape

#### Single-agent (from T1 setup teardown)

```xml
<agent_idle id="t1-agent" status="idle" session_id="019de973-3147-7259-a784-7822d5228d34">
ack magic phrase stored
<hint>Pass session_id to the resurrect tool to bring this agent back online with its prior conversation.</hint>
</agent_idle>
```

- `session_id` attribute on `<agent_idle>`: ✓
- Exactly one `<hint>` child: ✓
- **Verdict: pass.**

#### Group (from final cleanup teardown)

```xml
<group_complete>
  <summary>2 idle</summary>
  <agent id="t1-revived" status="idle" session_id="019de973-3147-7259-a784-7822d5228d34" />
  <agent id="t6-scout-revived" status="idle" session_id="019de974-776e-73d9-b61d-1ef1ec488ca2" />
  <hint>Pass any session_id above to the resurrect tool to bring an agent back online with its prior conversation.</hint>
  <usage input="19k" output="257" cost="$0.0744" />
</group_complete>
```

- `session_id` attribute on each `<agent>`: ✓
- Exactly one `<hint>` per teardown envelope: ✓ (not per-agent)
- `<hint>` placed after agent lines, before `<usage>`: ✓
- **Verdict: pass.**

#### Bonus observation

Resurrected agents (`t1-revived`, `t6-scout-revived`) reported the **same**
`session_id` they were resurrected from. Confirms resume semantics:
`--session <path>` reuses the bundle rather than minting a new id. This
means a resurrected agent can itself be torn down and resurrected again
from the same UUID — useful, and worth flagging as an implicit invariant
of the feature.

## Plan Updates

Added **J2: Subagent resurrect** to `tools/manual-test/PLAN.md` as a
primary user journey. Resurrection is high-value (recovery from premature
teardown) and a regression here would be catastrophic (silent capability
escalation per the review's §1 risk). J1 (subagent lifecycle) was added
in the same bootstrap pass — both ship with this run.

## Open Issues

None blocking. Two items recorded for context:

1. **T5 not exercised.** Cannot reproduce the literal "no subagent
   infrastructure for this parent session" error from inside a parent that
   already has infrastructure. Code path inspected and looks correct;
   would need a fresh parent harness to drive end-to-end. Not a fix
   target — recorded as a known harness limitation.
2. **Cross-restart resurrection not exercised.** Same reason — single-
   process manual-test agent cannot self-restart pi. The session-id-in-
   transcript design makes this case structurally indistinguishable from
   in-process resurrect, but "structurally" is not "empirically." Worth
   adding a dedicated harness later if a topic motivates it.
