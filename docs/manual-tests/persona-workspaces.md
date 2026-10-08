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
- **T10 Resume never slaps back** (R6, RPC + resume): after a user model +
  thinking change mid-session, a resume in the workspace (whose `model`/
  `tools` front matter was edited in between) keeps the user's model and
  thinking and the original tool set, still binds the *edited* body (prompt
  binding is per-run), and emits no second notice.
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

- Reused: `resume-restore/run.mjs` (J6), `model-tiers/run.mjs` (J7), the
  `pi --mode json/rpc` driver patterns those tools established (JSONL RPC
  framing, `before_provider_request` probe, persistence-file oracles).
- New: `tools/manual-test/persona-workspaces/run.mjs` — fixtures + checks for
  T1–T12; parameterized (models, markers, provider config via env/flags).
- Improved: `resume-restore/run.mjs` invoked with an external
  `PI_CODING_AGENT_DIR` so the working tree (not the installed package) is
  under test; documented in its README.

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
- **`reload` (extension reload) is not driven** — only `startup`/`new`/`fork`
  vs `resume`. The reload no-slap-back path is covered by unit tests only.
- **Single-user, sequential sessions** — no concurrency, compaction, or
  cross-session interaction is exercised.
- **Provider landscape drift (J7):** `model-tiers/run.mjs` pins the
  azure-foundry provider and specific deployment ids; azure-foundry auth is
  currently `invalid_state` in this environment, so that smoke run may fail
  environmentally rather than structurally.
- R6's "user's mid-session choice" is applied through RPC `set_model` /
  `set_thinking_level` (the same pi API behind `/model`), not the TUI dialog.

None of the gaps cover the topic's primary behavior (preamble replacement,
precedence, binding, notices as transcript-visible messages), so no
escalation was needed before executing.

## Results

(to be filled after execution)

## Plan Updates

(to be filled after execution)

## Open Issues

(to be filled after execution)
