# Manual Testing — quota-providers-decouple

## Smoke Suite

This run covers the changed provider and quota paths plus adjacent startup
journeys. It exercises J1/J2 (child startup and teardown/resurrection use the
same provider registry), J3 (fork), J4 (this phase), J6 (resume with provider
extensions), J7 (model-tier startup against the new provider), and J8/J9
(persona harnesses configured for `llmgateway`). J5 remains outside this
change because its persistent plan entry still has `driver: TBD`.

## Topic-Specific Tests

- **Provider-ID quota attachment** — configure a quota source against a
  complete provider ID, keep an unattached provider beside it, and verify only
  the named provider receives the guard. This is the central decoupling path.
- **Complete-provider stream boundary** — drive an allowed request and a
  blocked request through a local complete provider. Verify the blocked request
  fails before transport and the allowed request preserves the complete
  provider path.
- **Tree-scoped bypass and `/quota`** — toggle bypass in the live session and
  verify the soft-cap decision changes while the status command remains
  provider-scoped.
- **Usage-source persistence** — run the executable usage runner with a
  deterministic source. Verify one cache record contains snapshots and the
  opaque model-to-limit map, and that covered ledger entries are pruned.
- **LLM Gateway provider split** — start a real pi process with the
  `llmgateway` extension, wait for the persisted catalog, select a live model,
  and inspect provider/model state. No live completion request runs in this
  check, so it does not spend account quota.

## Tools

- Reused: `tools/manual-test/resume-restore/run.mjs`,
  `tools/manual-test/model-tiers/run.mjs`, and
  `tools/manual-test/persona-workspaces/run.mjs` for adjacent smoke paths.
- New: `tools/manual-test/quota-providers/run.mjs` — a parameterized RPC and
  runner harness using a local complete provider and deterministic quota source.
- Improved: the new Gateway probe waits for `models-store.json` and calls
  `set_model` after catalog publication. This avoids a false `unknown` result
  when the first RPC state request races the asynchronous catalog refresh.
- Improved: `resume-restore` now qualifies provider/model refs, reports child
  exit diagnostics, normalizes display thinking suffixes, and records actual
  worker topology. `model-tiers` scopes prompt-table parsing and reads child
  session evidence before teardown. `persona-workspaces` warms the first-run
  host patch, checks effective thinking levels, awaits the RPC reload barrier,
  and expects edited persona-pin precedence.
- New deterministic tests: `run.test.mjs` beside each corrected harness.

## Harness Limitations

- The quota harness uses a local provider and deterministic usage source. It
  does not exercise LLM Gateway completion transport, real account windows, or
  network failure behavior. The Gateway check uses the real catalog endpoint
  only when `LLMGATEWAY_API_KEY` and a suitable model are available.
- Headless RPC does not render the TUI footer. It checks status notifications,
  stream markers, and provider responses instead.
- The adjacent model-tier, persona, and resume harnesses drive real LLM calls.
  They need a live model catalog, can incur model cost, and can fail from
  model-specific reasoning or timing behavior. Their corrected versions were
  checked offline only in this pass. The prior temp agent directories were
  pre-seeded with the live Gateway catalog to avoid startup races.
- The persistent plan still has no driver for J5 (worktree lifecycle).

## Results

### Topic-specific tests

- **Provider-ID attachment and complete-provider boundary** — pass. Command:
  `QP_GATEWAY_MODEL=gpt-4o-mini node
  tools/manual-test/quota-providers/run.mjs --keep --timeout 90
  --workdir /tmp/quota-final6`. The local blocked case recorded no
  `streamSimple` transport marker and an RPC `quota hard cap exceeded` event.
  The allowed case recorded `attached:standard`. A second session whose model
  used the unattached provider recorded `unattached:standard`. Both provider
  IDs resolved as expected, so the result looks coherent.
- **Tree-scoped bypass and `/quota`** — pass (same command). The command
  notification reported `quota: $6/$10 ... soft cap`; `/quota bypass on`
  reported `Quota bypass turned on.`; the subsequent soft-capped stream reached
  `attached:standard`. The status and bypass affordances look coherent.
- **Usage-source persistence** — pass (same command). The runner exited 0.
  Its cache contained one `Monthly` snapshot with opaque `limitId: "monthly"`
  and `modelLimitIds: { premium: ["premium-weekly"] }`. The old ledger entry
  was pruned and the future entry remained. The record shape and pruning look
  coherent.
- **LLM Gateway provider split** — pass (same command). With the ambient
  `LLMGATEWAY_API_KEY` and `QP_GATEWAY_MODEL=gpt-4o-mini`, the real catalog was
  published, `set_model` returned success, and `get_state` reported
  `provider: "llmgateway"`, `model: "gpt-4o-mini"`. No completion request ran.
  The selected provider/model state looks coherent.

### Smoke journeys

The adjacent live runs below are prior observations. The corrected harnesses
were not rerun because this phase cannot issue another paid model request.
Offline command `node --test tools/manual-test/resume-restore/run.test.mjs
 tools/manual-test/model-tiers/run.test.mjs
 tools/manual-test/persona-workspaces/run.test.mjs` passed all eight tests in the
three `run.test.mjs` files.

- **J1 — subagent spawn/message/teardown:** prior D1 run passed. The corrected
  persona harness keeps the same structural oracles and adds first-run patch
  warmup. No live rerun. The prior journey looks coherent.
- **J2 — resurrect:** prior teardown and bogus-session checks passed. The prior
  `d2_resurrect_regates` model failure was a stale assertion: the edited
  workspace persona pin must win under the DR-038 amendment. The corrected
  harness expects the edited pin. No live rerun.
- **J3 — fork:** prior D2 fork checks passed. No live rerun.
- **J4 — workflow phase:** pass. This artifact, the new harnesses, deterministic
  helper tests, and README updates were produced and checked offline.
- **J5 — worktree lifecycle:** not run. The persistent plan has `driver: TBD`.
- **J6 — parent resume/restore:** prior `rr-final4` had six live checks pass;
  the model mismatch came from `check_status`'s display-only `:off` suffix, and
  the subgroup mismatch came from real worker tool drift. The corrected harness
  accepts `--provider`, splits `provider/model` refs, reports child exit/stderr,
  normalizes valid thinking suffixes, restricts the spawn parent to
  `subagent`, and compares subgroup state with the persisted worker topology.
  The nested topology is reported as an observation instead of timing out.
  No live rerun.
- **J7 — model-tier selection:** prior A/B/C failures came from matching the
  generic first `| cheap |` row. The product table is static guidance by
  contract. The corrected harness scopes table extraction, checks guidance
  rows, puts project `cheap` in D to exercise overlay precedence, and reads
  child session files from `agent_added` records before parent teardown. No
  live rerun.
- **J8/J9 — persona takeover and spawned identity:** prior R1 failed because
  the first process used the documented stacked fallback before the host patch
  restart; thinking checks used non-reasoning models; R7 read an early reload
  signal before `ctx.reload()` completed; D2 expected persisted model instead
  of the edited persona pin. The corrected harness warms the host patch without
  a model request, checks effective thinking levels, awaits the RPC reload
  response, and expects edited-pin precedence. No live rerun.

## Plan Updates

None. The new quota harness covers topic-specific behavior and does not add a
new primary journey to the persistent plan. J5 remains `driver: TBD`.

## Open Issues

- **Live adjacent rerun pending:** corrected resume, model-tier, and persona
  harnesses need a future live run to verify their new control flow. No paid
  request was made in this correction pass.
- **Real-model task drift remains a limitation:** resume nesting and model-tier
  tool order are observed from persistence rather than treated as deterministic
  instructions. The corrected harness reports topology/evidence instead of
  converting drift into a product failure.
- **R7 product behavior remains unconfirmed until live rerun:** the harness
  now waits for the RPC `prompt` response after `ctx.reload()` before checking
  model state and prompt payloads.
- **J5 has no driver:** worktree lifecycle remains untested by the persistent
  manual suite.
- **TUI-only surfaces:** the quota footer renderer and visual layout were not
  exercised in headless RPC mode. Status content was verified through RPC
  notifications.
