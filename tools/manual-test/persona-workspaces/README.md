# persona-workspaces

Drive real `pi` processes to verify persona takeover end-to-end — the live
wiring in `extensions/persona-workspaces/index.ts` and the subagents spawn
path (active-persona selection, spawn-declared payload carriage) that the
pure-function unit tests cannot reach.

## Purpose

Each check runs a real top-level pi under a controlled `PI_CODING_AGENT_DIR`
(a temp agent dir whose `settings.json` loads this repo as a package plus a
`before_provider_request` probe extension). The probe appends every assembled
provider payload to a NDJSON file so the harness inspects the exact system
prompt, tool list, and model each request ran with. Notices and binding state
come from session JSONL, the subagents persistence files, and RPC
`get_state`/`get_commands` — never from model narration.

## Checks

Root checks (fresh `pi --mode rpc` sessions; R5/R6 use two):

- **R1 silent-takeover** — `kind: persona` AGENTS.md: body replaces the
  preamble (generic preamble gone, body exactly once — the file is not
  double-appended as context), no notice (the takeover is silent —
  `/sysprompt`'s projection is the pre-run visibility surface), front-matter `model`
  (with `:<level>` thinking suffix), `tools` (exactly
  `resolveChildToolPolicy` normalization: `ask_user` dropped, `respond`
  appended), `skills` filter, and unlisted skills' slash commands still
  loaded (the documented root-session limitation).
- **R2 explicit-prompt** — `--system-prompt` outranks the ambient persona:
  nothing binds, nothing announces, the AGENTS.md stays ordinary project
  context.
- **R3 plain-agents** — a plain AGENTS.md never takes over: generic preamble
  intact, content rides as project context, no notice.
- **R4 unknown-kind** — `kind:` other than `persona` is silently ignored.
- **R5 mid-session-edit** — editing the workspace body takes effect on the
  next run of the same session; no notice ever fires (takeovers are silent).
- **R6 resume-rebinds** — a tier-name `model` pin binds through
  model-tiers.json; after an in-session `set_model` + `set_thinking_level`
  (the `/model` API) the choice stands mid-session, but a resume whose
  AGENTS.md model/tools were edited meanwhile is persona-authoritative at the
  session boundary: the edited declaration's model (with its `:<level>`
  thinking suffix) and tools rebind over the user's choices, the edited body
  still binds (prompt binding is per-run), and nothing announces.
- **R7 reload-rebinds** — an extension-command-triggered reload (the
  probe's `pw-reload` calls `ctx.reload()`, the same `session.reload()` the
  builtin `/reload` runs) is dispatched as a `reload` session start: reload
  is a continuation boundary (the same thing as a resume), so the edited
  declaration re-applies in full — model (with its `:<level>` thinking
  suffix) and tools whitelist — over the user's mid-session choices; the
  edited body still binds per-run and no second notice fires. pi-core reload
  resets the active tool selection to the default set; the rebind restores
  the declared set.

Drive checks (LLM-driven parent sessions spawning real children):

- **D1 spawned-identity** — a spawned persona's body IS the child's preamble
  (generic preamble gone, body once — not stacked in the addendum) with no
  notice (persona takeovers are silent); a persona without a
  `model` lets an explicit spawn `model` gap-fill; a child spawned into an
  arbitrary folder loads that folder's project resources (project skill in
  the prompt, plain AGENTS.md as project context, project `.pi/extensions`
  extension fires); messaging works (expect-response and fire-and-forget).
- **D2 override+resurrect** — a named persona spawned into a persona
  workspace loses wholesale to the workspace (body + model pin), the override
  notice names both and the subagent tool result carries the override note;
  after teardown the workspace file is edited and the
  resurrected child re-resolves its tool policy from the edited file while its
  persisted model survives (DR-038); a `fork` child of a persona-workspace
  parent wears the workspace persona (body + declared model pin + tool set)
  silently; a bogus resurrect errors cleanly.

## Invocation

```
node tools/manual-test/persona-workspaces/run.mjs [--keep] [--timeout <sec>] [--workdir <dir>] [--only <ids>]
```

- `--keep` — do not delete the temp workdir on exit (default: delete unless
  `--workdir` was passed).
- `--timeout <sec>` — per-phase timeout (default 300).
- `--workdir <dir>` — use an explicit workdir instead of a fresh mkdtemp.
- `--only R1,D2` — run a subset of checks (by prefix id).
- `PW_VERBOSE=1` — echo pi stderr for debugging.

## Inputs / Outputs

- **Inputs:** flags and env overrides: `PW_PROVIDER`, `PW_MODEL` (session
  default), `PW_PIN_A` + `PW_PIN_A_LEVEL` (R1/R6 pin and thinking suffix),
  `PW_PIN_B` (workspace W2 pin + R6 edited pin), `PW_PIN_C` (spawned persona
  pin + R6 user choice), `PW_RAW` (explicit spawn model), `PW_THINK` (R6 user
  thinking level). Defaults target the devpass provider and **standard-tier**
  models — premium-tier models are unusable while the gateway's weekly
  premium allowance is spent (402).
- **Outputs:** human phase log on stderr; JSON verdict on stdout
  `{ verdict, checks, observed }`. Exit 0 = PASS, 1 = FAIL.

## Prerequisites

`pi` on PATH with this repo loadable as a package; `LLMGATEWAY_API_KEY` in
env (the devpass quota-provider implementation is registered in the temp
agent dir and discovers models at startup). The temp quota config relaxes
`lookaheadHours` so the quota soft-cap backpressure cannot block these checks'
provider calls (the account's real spend pace is ahead of budget; quota
behavior is out of scope here).

## Use for

Any topic touching persona takeover: workspace `kind: persona` declarations,
spawned-persona preamble replacement, persona source precedence and override
notices, front-matter model/tools/skills binding, or the subagents
active-persona spawn path (pin-vs-explicit model precedence, resurrect
capability-gate re-resolution, fork persona inheritance, child project
resources). Limitations: drives are headless (`--mode rpc`) so the
`persona-notice` TUI renderer chrome is not exercised (the notice message
itself is); persona `model` pins on premium tiers are unexercised while the
weekly premium allowance forbids them (add a premium-pinned persona case
when it allows); three of resurrect's four documented error paths are not
driven (the bogus-session-id path is) — fold into a future J2 run. The
D-drives ask a real LLM for a precise tool-call sequence, so
all oracles are structural (probe payloads, session JSONL, persistence
files), never narration. Reload is driven through the probe's `pw-reload`
extension command (pi's builtin `/reload` is UI-pipeline-dispatched only;
`prompt("/name")` dispatches extension commands).
