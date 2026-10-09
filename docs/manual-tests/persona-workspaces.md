# Manual Testing — persona-workspaces

Re-verification round for the notice ruling (commit `d229d6a` + `5d53d6c`,
live at the installed clone at the same revision). Prior artifacts were
consumed by cleanup (`b781edf`, DRs DR-053/DR-054/DR-056 extracted); this
artifact records this run only.

## Smoke Suite

Targeted round scoped by the task: the persona-workspaces record run
re-exercises J1 (spawn/message/teardown inside D1/D2), J2 (teardown +
resurrect + one error path in D2), J3 (fork in D2), and J8/J9 (the persona
journeys, checks R1–R7). J4 is implicit (this artifact is the phase output).
J5–J7 out of scope this round (their drivers and code paths are untouched by
the notice ruling; last green runs stand).

## Topic-Specific Tests

Notice-ruling surfaces, per the updated expectations:

- **Silent takeover everywhere** — `r1_silent_takeover` (root boot),
  `r5_no_notice` (mid-session edit runs), `r6_no_notice` (CLI resume),
  `r7_reload_no_notice` (reload, count 0), `d1_silent_spawn` (spawned
  persona child), `d2_parent_silent_takeover` (workspace root), fork silence
  (`d2_fork_persona`, zero notices).
- **Override notice child-side** — `d2_override_notice`: the only remaining
  `persona-notice`, emitted in the child transcript when a spawn-declared
  persona loses wholesale to the workspace persona (condition `override`,
  names winner + replaced + source path), once per condition.
- **Tool-result awareness note** — `d2_override_tool_note`: the `subagent`
  tool result carries `persona 'X' overridden by workspace persona 'Y'
  (<cwd>)` so the calling LLM's belief about what it deployed is corrected at
  spawn time.
- **`/sysprompt` empty-session projection** (5d53d6c, spot-check): before the
  first turn, `/sysprompt` projects the persona preamble.

## Tools

- Reused: `tools/manual-test/persona-workspaces/run.mjs` (record suite,
  updated by `d229d6a` to the notice-ruling expectations).
- Spot-check driver: ad-hoc RPC invocation of the `sysprompt` extension
  command (`prompt("/sysprompt")` — extension commands are prompt-
  dispatchable), asserting the `print-prompt` entry on the RPC stream
  (`entry_appended`) and the session file.

## Harness Limitations

- Headless drivers: the `persona-notice` / `print-prompt` TUI renderer chrome
  is not exercised; message and entry contents are (which carry the complete
  information per the plan).
- D-drives ask a real LLM for an ordered tool-call sequence; all oracles are
  structural (probe payloads, session JSONL, persistence files, tool-result
  text), never narration.
- Reload is driven via the probe's `pw-reload` extension command (the builtin
  `/reload` is UI-pipeline-dispatched only).
- Premium-tier persona models remain unexercisable (weekly premium allowance
  spent); all fixture pins are standard-tier.
- `rpcSession.ready()` waits for a resolved session model before prompting
  (guards the provider catalog cold start that flaked an earlier round).

## Results

Record run: `node tools/manual-test/persona-workspaces/run.mjs --keep
--workdir /tmp/pw-record5` → **48/48 checks PASS, 0 fail** (verdict JSON
kept). Unit suite at this revision: `npx vitest run` → 822/822 green.

- **Silent takeover everywhere** — pass (7/7): `r1_silent_takeover`,
  `r5_no_notice`, `r6_no_notice`, `r7_reload_no_notice`, `d1_silent_spawn`,
  `d2_parent_silent_takeover`, fork silence — zero notices in every
  transcript (root boot, mid-session runs, CLI resume, reload, spawned
  children, workspace root, fork carry-over).
- **Override notice child-side** — pass: `d2_override_notice` recorded
  exactly one `customType: "persona-notice"` entry in the child transcript —
  `{condition: "override", persona: "wslead", replaced: "zeta", sourcePath:
  <workspace AGENTS.md>}` — and `d2_no_reannounce` confirms it fires once per
  condition. Coherence: the notice text names both personas and the winning
  source file — **looks coherent**.
- **Tool-result awareness note** — pass: `d2_override_tool_note` observed
  `persona 'zeta' overridden by workspace persona 'wslead'
  (/tmp/pw-record5/D2/work)` in the `subagent` tool result. Coherence: the
  note lands where the calling LLM reads it, names both personas and the
  governing cwd — **looks coherent**.
- **`/sysprompt` empty-session projection** — pass (spot-check): with an
  empty session in a persona workspace, `prompt("/sysprompt")` dispatched the
  `sysprompt` extension command (`disposition: "handled"`), which emitted a
  `print-prompt` entry whose text begins `[projected — persona binds at the
  first turn]` followed by the persona body as the preamble
  (`You are SysLead. SYSPT-BODY-99.` + tools docs). 5d53d6c behavior
  confirmed live.
- **Unchanged behavior re-verified live** (all pass): R1 preamble/model/tools/
  skills binding + slash-command residue; R2 explicit `--system-prompt`
  precedence; R3/R4 non-persona files untouched; R5 per-run body binding;
  R6 continuation rebind loop (model + `:<level>` thinking + whitelist over
  mid-session choices; `/model` stands through run boundaries);
  R7 reload-rebinds; D1 body-as-identity, gap-fill, child project resources,
  messaging; D2 override body wholesale, pin-beats-explicit, resurrect
  re-gates + persisted model, fork rebind.

Pass/fail counts: **record run 48/48 PASS** (0 fail); `/sysprompt` spot-check
1/1 PASS.

## Plan Updates

- **Modified J8/J9** announcement wording in `tools/manual-test/PLAN.md` to
  the notice ruling: takeovers are silent; the only announcement is the
  child-side override notice plus the `subagent` tool-result note
  (previously: "announcements fire only on genuine takeover").

## Open Issues

- **TUI chrome untested**: `persona-notice` / `print-prompt` renderer layout
  (Box/Text, theme, narrow widths) and the pimote panel counterpart are
  invisible to headless drivers; message content is fully verified.
- **Premium-tier pins unexercised** (weekly premium allowance spent): add a
  premium-pinned persona case when the allowance resets.
- **Three of resurrect's four documented error paths** were not driven (the
  bogus-session-id path was); fold into a future J2 run.
