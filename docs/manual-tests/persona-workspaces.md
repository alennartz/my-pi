# Manual Testing — persona-workspaces

## Smoke Suite

Scoped by focus hints (persona workspaces); `tools/manual-test/PLAN.md` journeys
exercised this run:

- **J1 Subagent lifecycle** — spawn / message / teardown ride inside the
  topic drives (D1, D2): the spawn path *is* this topic's surface. Fire-and-
  forget + expect-response messaging exercised once on a spawned persona child.
- **J2 Subagent resurrect** — D2 tears a persona child down and resurrects it
  (happy path + one bogus-session-id error path). Resurrection is topic-
  adjacent: it re-resolves the active persona file (T11).
- **J3 Fork** — D2 forks from a persona-workspace parent; the fork child must
  wear the inherited workspace persona (T12).
- **J4 Workflow pipeline** — exercised implicitly: this run is the
  manual-testing phase and its artifact lands in `docs/manual-tests/`.
- **J6 Parent session resume** — `tools/manual-test/resume-restore/run.mjs`,
  run under a controlled agent dir so the working tree is under test.
- **J7 Model-tier selection** — `tools/manual-test/model-tiers/run.mjs`
  as-is (persona `model` pins resolve through the same tier vocabulary).
- **J5 Worktree** — skipped per focus hints (untouched by this topic).

## Topic-Specific Tests

Driver: new `tools/manual-test/persona-workspaces/run.mjs` (see *Tools*).
Fixtures use unique marker strings in persona bodies so prompt assembly can be
asserted structurally. Checks R* are root-side fresh `pi` runs; D* are LLM-
driven parent sessions that spawn real children.

- **T1 Root takeover** (R1): pi booted in a directory whose `AGENTS.md` has
  `kind: persona` — the persona body replaces the preamble wholesale (generic
  preamble absent), the transcript gains one `customType: "persona-notice"`
  boot message naming the persona and its absolute source file, and the
  workspace's own AGENTS.md is not double-appended as project context.
- **T2 Spawned persona is identity** (D1): `subagent` with a discovered
  persona definition — the child's preamble IS the definition body (generic
  preamble absent, body not stacked in an addendum), and the child gets a
  name-only boot notice (no fabricated `sourcePath`).
- **T3 Workspace overrides spawned persona** (D2): a named persona spawned
  into a persona workspace — the workspace wins wholesale (spawned body and
  its fields never bind) and the override notice names both the winning
  persona and the replaced spawned agent.
- **T4 Front-matter binding at session start** (R1): `model` (with `:<level>`
  thinking suffix) binds via the model registry; `tools` binds with exactly
  `resolveChildToolPolicy` normalization (`ask_user` dropped, `respond`
  appended); `skills` filters the per-run skill list while unlisted skills'
  slash commands stay loaded (the documented root-session limitation — pinned
  so future runs notice any change).
- **T5 Child project resources from an arbitrary folder** (D1c): a child
  spawned into a plain, never-trusted-before directory loads that folder's
  project resources — project skill visible in the child's prompt, the
  folder's plain AGENTS.md rides as project context, and a project
  `.pi/extensions` probe fires (trust-machinery removal).
- **T6 Model precedence** (D1b, D2): a persona `model` pin beats an explicit
  `model` spawn argument (and the discarded spawned definition's pin never
  applies); the explicit argument gap-fills only when the active persona
  declares no `model`.
- **T7 Explicit `--system-prompt` outranks the ambient persona** (R2): nothing
  binds, nothing announces, and the AGENTS.md stays ordinary project context.
- **T8 Non-persona AGENTS.md files are left alone** (R3, R4): a plain
  AGENTS.md and one with an unknown `kind:` value never take over — generic
  preamble intact, file content stays project context, no notice.
- **T9 Mid-session edits take effect next run** (R5, RPC, one session
  instance): editing the workspace AGENTS.md body changes the next run's
  preamble; the takeover notice is not re-emitted.
- **T10 Resume rebinds — persona-authoritative at session boundaries**
  (R6, RPC + resume; re-verified live after the ruling in `916add2`): a
  tier-name `model` pin binds through model-tiers.json; a user model +
  thinking change mid-session stands through run boundaries (spot-check: the
  run after `/model` executes with the user's model — no slap-back at run
  boundaries), but a resume in the workspace (whose `model`/`tools` front
  matter was edited in between) re-applies the edited declaration — model
  (with its `:<level>` thinking suffix) and tool whitelist (exact
  `resolveChildToolPolicy` normalization) — over the user's choices; the
  *edited* body binds per-run and the resume announces nothing.
- **T13 Reload never rebinds** (R7, RPC + probe `pw-reload` command): an
  extension reload (`ctx.reload()` = `session.reload()`, the same path the
  builtin `/reload` runs) dispatched mid-session after an AGENTS.md edit
  applies no declaration fields — the user's model + thinking stand — while
  the edited body still binds per-run and no second notice fires. pi-core
  reload resets the active tool selection to pi's default set (see *Open
  Issues*).
- **T11 Resurrect re-resolves capability gates** (D2): after teardown, the
  workspace file's `model`/`tools` are edited; the resurrected child's tool
  policy comes from the edited file (gates re-resolved) while its persisted
  model survives (DR-038) and no second notice fires.
- **T12 Fork inherits the workspace persona** (D2): a `fork` child of a
  persona-workspace parent wears the workspace persona with a boot notice.

Promoted to `tools/manual-test/PLAN.md` this run: J8 (persona workspace
takeover) and J9 (spawned persona identity + override); J1/J2 wording updated
for the `persona` parameter and body-as-preamble semantics.

## Tools

- Reused: `resume-restore/run.mjs` (J6, run with an external
  `PI_CODING_AGENT_DIR` so the working tree — not the installed package — is
  under test), `model-tiers/run.mjs` (J7), the `pi --mode json/rpc` driver
  patterns those tools established (JSONL RPC framing,
  `before_provider_request` probe, persistence-file oracles).
- New: `tools/manual-test/persona-workspaces/run.mjs` (+ README) — fixtures
  + checks for T1–T12; parameterized (providers, models, markers via
  `PW_*` env, `--only` subset runs).
- Improved:
  - `model-tiers/run.mjs` — provider/model landscape parameterized
    (`MT_PROVIDER`/`MT_MODEL`/`MT_TIER_MODEL`/`MT_RAW_MODEL`/
    `MT_PROJECT_MODEL`) after azure-foundry drift made its hardcoded
    environment unusable; provider-agnostic system-prompt extraction
    (openai-style payloads carry the prompt as a `developer` message, not a
    `system` field); devpass quota-provider support in its temp agent dir
    (with relaxed soft-cap lookahead); check C re-anchored to the post-review
    trust-independent overlay semantics (it still pinned the removed trust
    gating). Documented in its README.
  - `resume-restore/README.md` — documents the `PI_CODING_AGENT_DIR`
    passthrough used to target the working tree.

## Harness Limitations

- **TUI chrome is not exercised.** All drivers are headless (`--mode json` /
  `--mode rpc`). The registered `persona-notice` renderer (Box/Text layout,
  theme colors, narrow-width wrapping) and its pimote panel counterpart are
  structurally invisible to this harness — layout bugs there cannot surface.
  What *is* verified is the notice message itself (type, `display: true`, full
  plain-text content), which per the plan carries the complete information.
- **LLM-driven ordered tool calls.** D-drives ask a real model to make a
  precise sequence of tool calls; instruction drift is possible. All oracles
  are structural (probe payloads, session JSONL, persistence files), never
  narration, so drift shows up as a retry, not a false pass.
- **Reload is driven via a probe hook, not the builtin `/reload`** — pi's
  builtin commands are dispatched by the TUI input pipeline only; R7 triggers
  the same `session.reload()` through the probe's `pw-reload` extension
  command (`prompt("/name")` dispatches extension commands).
- **Premium-tier persona models are structurally unexercisable today.** The
  gateway's weekly premium allowance is spent (402 on any premium model), so
  all fixture pins use standard-tier models. A persona pinning a premium
  model (e.g. `claude-opus-5-5`) and its failure surfacing cannot be covered
  by this run's harness.
- **Pi does not persist active-tool selection** — not across process restarts
  and not across reloads (model/thinking are persisted). The declared
  whitelist is observable at binding and at the session-start rebind that
  restores it (post-ruling); after a reload, pi's default set runs until the
  session is next opened — see *Open Issues*.
- **Single-user, sequential sessions** — no concurrency, compaction, or
  cross-session interaction is exercised.
- R6's "user's mid-session choice" is applied through RPC `set_model` /
  `set_thinking_level` (the same pi API behind `/model`), not the TUI dialog.

None of the gaps cover the topic's primary behavior (preamble replacement,
source precedence, front-matter binding, notices as transcript-visible
messages — all structurally verified against probe payloads and session
files), so no escalation was needed before executing.

## Results

Record run (live re-verification after the persona-authoritative ruling,
`916add2`): `node tools/manual-test/persona-workspaces/run.mjs --keep
--workdir /tmp/pw-record2` → **47/47 checks PASS** (verdict JSON kept; the
prior 42-check run is superseded). Full unit suite at this commit:
`npx vitest run` → 818/818 green. The record run re-exercised J1–J3 live
(D1/D2 green); J6/J7 drivers and their code paths are untouched by the
ruling and remain at the green runs recorded below.

### Smoke Suite

- **J1 Subagent lifecycle** — pass. D1 spawned three children (persona,
  persona+model, plain+foreign-cwd) and exchanged messages both
  expect-response (reply surfaced to the parent) and fire-and-forget; D2 ran
  spawn → teardown with the completion report surfacing `session_id`
  verbatim. Coherence: the tool results read cleanly ("Agents spawned: 1
  agent (zeta-child)…", "Agent \"zeta-child\" removed. <agent_torn_down …>") —
  **looks coherent**.
- **J2 Subagent resurrect** — pass. D2 resurrected the torn-down persona
  child (prior conversation intact: it recalled and answered its second
  task) and the bogus-id error path returned `No session found with id
  bogus-session-123.` Coherence: error text precise and actionable — **looks
  coherent**. (Three further documented error paths not driven this run.)
- **J3 Fork** — pass via D2's `fork` call: the fork child ran an independent
  task with the parent's full context (its file carries the parent's turns)
  and wore the workspace persona (T12).
- **J4 Workflow pipeline** — pass (implicit): this run produced
  `docs/manual-tests/persona-workspaces.md` and the tool/plan updates, i.e.
  the phase artifact landed as designed.
- **J5 Worktree** — skipped per focus hints (untouched by this topic).
- **J6 Parent session resume** — pass: `resume-restore/run.mjs` under a
  controlled `PI_CODING_AGENT_DIR` (working tree) — 8/8 checks (restored
  child `idle`, model/usage/cost/turns/lastOutput recomputed against an
  independent re-parse). Coherence: `check_status` detail reads naturally
  ("Agent: worker / State: idle / Model: … / Last output: ACK") — **looks
  coherent**.
- **J7 Model-tier selection** — pass after harness generalization: 9/9
  checks under `MT_PROVIDER=devpass-openai-completions` (injection table,
  overlay merge, trust-independent overlay, live tier/raw spawns,
  unconfigured notice, `list_models` catalog). Coherence: tier rows render as
  `` `model` (default) `` / configured values consistently — **looks
  coherent**.

### Topic-Specific Tests

- **T1 Root takeover** (R1) — pass (7 checks): body replaces the preamble
  (generic preamble absent, body exactly once — no double context append),
  boot notice `Persona takeover: "BenchLead" (/abs/AGENTS.md) is now this
  session's persona.` with `display: true`, model pin `gpt-6-luna:low` bound
  with thinking `low`, tools bound exactly `[bash, read, respond]`, skills
  filtered to `codemap`, `skill:debugging` slash command still loaded (the
  documented limitation holds). Coherence: the notice text names who took
  over and from which file — **looks coherent**.
- **T2 Spawned persona is identity** (D1) — pass: child preamble IS `ZETA-
  BODY-11` (once; generic preamble absent — nothing stacked), name-only boot
  notice `Persona takeover: spawned persona "zeta" …` with no fabricated
  sourcePath.
- **T3 Workspace overrides spawned persona** (D2) — pass: child preamble is
  the workspace body only (spawned body absent), override notice `Persona
  override: workspace persona "wslead" (/abs/AGENTS.md) replaces the spawned
  persona "zeta" …` naming both. Coherence: the notice corrects exactly the
  orchestrator's belief — **looks coherent**.
- **T4 Front-matter binding** (R1 + R6) — pass: `model` + `:<level>` binds
  (also via tier name in R6: `cheap` → `gpt-6-luna`), `tools` bind with exact
  `resolveChildToolPolicy` normalization, `skills` filters the per-run list,
  unlisted skill slash commands remain (limitation pinned).
- **T5 Child project resources** (D1c) — pass: the fx folder's plain AGENTS.md
  rides as project context, its project skill appears in the child's prompt,
  and its project `.pi/extensions` extension fired (`ext-loaded.txt` written)
  — the always-trusted child cwd path works.
- **T6 Model precedence** (D1b, D2) — pass: workspace pin beats both the
  spawned persona's pin and an explicit `model` argument (`gpt-6.1-sol`, not
  `claude-haiku-5-5`/`gpt-6-luna`); the explicit argument gap-fills a
  pin-less persona (`gpt-6-luna`).
- **T7 Explicit `--system-prompt` outranks the ambient persona** (R2) — pass:
  the explicit text is the preamble, nothing announces, the AGENTS.md stays
  ordinary project context.
- **T8 Non-persona AGENTS.md left alone** (R3, R4) — pass: plain and
  `kind: overlay` files never take over (generic preamble intact, content
  rides as context, no notice).
- **T9 Mid-session edits apply next run** (R5) — pass: v1 body bound on run 1,
  v2 on run 2 of the same session instance, exactly one notice.
- **T10 Resume rebinds** (R6) — **pass (re-verified)** after the ruling in
  `916add2`. History for the record: the first run exposed that pi dispatches
  `session_start` reason `startup` for every initial runtime — including
  `pi --session <existing>` — which rebound at resume against the then-
  governing anti-slap-back intent (fixed inline in `7415760` with
  fresh-session-instance detection); the follow-up user ruling then made the
  persona authoritative at session boundaries, implemented in `916add2`,
  re-scoping binding to "every session start but `reload`" and keeping the
  fresh-instance derivation as the announcement gate only. Live at the record
  run: the edited declaration's model (`gpt-6.1-sol`) and `:high` thinking
  rebind over the user's `claude-haiku-5-5`/`medium`, the edited whitelist
  (`[read, respond]`) rebinds, the edited body binds per-run, zero second
  notices; the mid-session spot-check confirms the run after `/model`
  executed with the user's model. Coherence: the boundary semantics read as
  the ruling intends — **looks coherent**. (38 unit tests green.)
- **T13 Reload never rebinds** (R7) — pass: reload dispatched live (probe
  reason log records `reload`), no declaration field applied (user model +
  thinking stand, the edited `[read, respond]` whitelist absent), edited body
  binds per-run, no second notice. Coherence: **looks coherent**. New
  observation (→ *Open Issues*): pi-core reload resets active tools to pi's
  default set — the boot-bound whitelist survives neither restart nor
  reload; only the session-start rebind restores it.
- **T11 Resurrect re-resolves capability gates** (D2) — pass: with the
  workspace file edited while torn down, the resurrected child's tool policy
  came from the edited file (`[bash, read, respond]`) while its persisted
  model (`gpt-6.1-sol`) survived (DR-038); exactly one notice in the child
  transcript.
- **T12 Fork inherits the workspace persona** (D2) — pass: fork child's
  preamble is the workspace body (v2, post-edit), construction-bound to the
  workspace model pin (`gpt-6-luna`) and tool set, boot notice names wslead +
  source path.

## Plan Updates

- **Added J8** (persona workspace takeover — the directory IS the
  specialist): the topic's root journey, driver `persona-workspaces/run.mjs`
  R1–R7.
- **Modified J8** (post-ruling wording): resume is persona-authoritative —
  reopening a session re-applies the declaration's model/thinking/tools over
  mid-session choices, `reload` never rebinds, and announcements stay
  fresh-instance-gated (resume/reload silent).
- **Added J9** (spawned persona identity — body as preamble, workspace
  override): the topic's spawn journey, driver `persona-workspaces/run.mjs`
  D1–D2.
- **Modified J1** — spawn wording now covers the `persona` parameter and
  body-as-preamble semantics.
- **Modified J2** — resurrect wording now covers capability-gate
  re-resolution from the active persona file while the persisted model
  survives.
- J7's driver entry unchanged (the tool's env parameterization is an
  invocation detail, not a journey change).

## Open Issues

- **pi drops the active-tool selection at reload** (restored at the next
  open by the session-start rebind, per the persona-authoritative ruling):
  after an extension reload the session runs pi's default tool set until the
  session is reopened. If the declared whitelist should survive reloads too,
  that needs pi-level tool-state persistence or a ruled reload-rebind — user
  decision.
- **`reload` no-rebind is now live-verified** (T13/R7) — closed this
  re-verification; retained here only as history: it was previously
  unit-tested only.
- **TUI chrome untested**: the `persona-notice` renderer (Box/Text layout,
  theme colors, narrow widths) and its pimote panel counterpart are
  structurally invisible to headless drivers; the notice message content is
  fully verified.
- **pi dispatch quirk worth a DR at cleanup**: `session_start` reason
  `startup` covers CLI-opened *existing* sessions (`resume` is only for
  in-process switches). Any extension distinguishing fresh-vs-resumed by the
  reason set alone has the same trap; the fresh-session-instance detection
  (transcript/`parentSession`, introduced in `7415760` and retained as the
  announcement gate under `916add2`) is the local remedy.
- **Premium-tier pins unexercised** (harness limitation above): with the
  weekly premium allowance restored, add a premium-pinned persona case to
  `persona-workspaces/run.mjs`.
- Three of resurrect's four documented error paths were not driven (the
  bogus-session-id path was); fold into a future J2 run.
