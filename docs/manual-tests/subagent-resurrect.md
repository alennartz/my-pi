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

To be filled as tests run.

## Plan Updates

To be filled.

## Open Issues

To be filled.
