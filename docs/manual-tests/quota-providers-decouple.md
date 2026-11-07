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

## Harness Limitations

- The quota harness uses a local provider and deterministic usage source. It
  does not exercise LLM Gateway completion transport, real account windows, or
  network failure behavior. The Gateway check uses the real catalog endpoint
  only when `LLMGATEWAY_API_KEY` and a suitable model are available.
- Headless RPC does not render the TUI footer. It checks status notifications,
  stream markers, and provider responses instead.
- The adjacent model-tier, persona, and resume harnesses drive real LLM calls.
  They need a live model catalog, can incur model cost, and can fail from
  model-specific reasoning or timing behavior. Their temp agent directories
  were pre-seeded with the live Gateway catalog to avoid startup races.
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

- **J1 — subagent spawn/message/teardown:** pass for the adjacent persona
  drive. Command:
  `PW_MODEL=gpt-4o-mini PW_PIN_A=qwen-flash PW_PIN_B=qwen-plus
  PW_PIN_C=glm-4.6v-flashx PW_RAW=glm-4.6v-flashx node
  tools/manual-test/persona-workspaces/run.mjs --keep --timeout 180
  --workdir /tmp/pw-pre`. D1 reported live `zeta-child`, `eta-child`, and
  `fx-child`; messaging and child project-resource checks passed. The journey
  looks coherent where exercised.
- **J2 — resurrect:** fixed teardown and the bogus-session error path passed in
  D2. The resurrect capability re-gating check failed (`d2_resurrect_regates`)
  because the observed tool set stayed `bash, read, respond` and the model was
  `qwen-flash`. A separate resume driver also completed but had one model-oracle
  mismatch. This journey looks off because adjacent harness expectations did
  not fully agree with the live session state.
- **J3 — fork:** pass in D2 (`d2_fork_persona`), including persona body, model,
  tools, and no notice. The continuation looks coherent.
- **J4 — workflow phase:** pass. This artifact, the new harness, and the
  registered README entry were produced and exercised. The phase output is
  coherent.
- **J5 — worktree lifecycle:** not run. The persistent plan has `driver: TBD`
  and this topic does not change worktree code. No pass is claimed.
- **J6 — parent resume/restore:** the non-nested command
  `PI_CODING_AGENT_DIR=/tmp/rr-agent RR_VERBOSE=1 node
  tools/manual-test/resume-restore/run.mjs --timeout 120 --keep
  --workdir /tmp/rr-final4` completed the spawn/resume flow. Six checks passed:
  idle state, last output, turns, input, output, and cost. Two checks failed:
  `modelRecomputed` compared `gpt-4o-mini:off` with the transcript's
  `gpt-4o-mini`, and `subgroupInputMatches` observed a child spawned by the
  live worker despite non-nested mode. A nested run,
  `PI_CODING_AGENT_DIR=/tmp/rr-agent RR_VERBOSE=1 node
  tools/manual-test/resume-restore/run.mjs --nested --timeout 120 --keep
  --workdir /tmp/rr-nested`, timed out during spawn. The restore result looks
  off because the adjacent harness has a thinking-suffix oracle mismatch and
  real-model tool-call drift.
- **J7 — model-tier selection:** command:
  `MT_MODEL=gpt-4o-mini MT_TIER_MODEL=qwen-flash MT_RAW_MODEL=glm-4.6v-flashx
  MT_PROJECT_MODEL=qwen-plus node tools/manual-test/model-tiers/run.mjs --keep
  --timeout 180 --workdir /tmp/mt-pre`, with each phase's
  `models-store.json` pre-seeded from the live Gateway catalog. Four checks
  passed (`D_noUnconfiguredNotice`, `F`, `E_defaultModel`,
  `E_unconfiguredNotice`). Five checks failed: A/B/C tier-table row parsing,
  and D's configured tier/raw child model observations. The observed A/B/C rows
  matched the generic Model Tiers guidance table rather than the injected
  table, so this run looks off because the harness parser is stale against the
  current prompt shape.
- **J8/J9 — persona takeover and spawned identity:** command:
  `PW_MODEL=gpt-4o-mini PW_PIN_A=qwen-flash PW_PIN_B=qwen-plus
  PW_PIN_C=glm-4.6v-flashx PW_RAW=glm-4.6v-flashx node
  tools/manual-test/persona-workspaces/run.mjs --keep --timeout 180
  --workdir /tmp/pw-pre`, with a live catalog pre-seeded in the shared agent
  directory. Root takeover, explicit-prompt precedence, plain/unknown AGENTS,
  mid-session edit, spawned identity, messaging, override notice, fork, and
  most resume/reload checks passed. Five checks failed: `r1_preamble`,
  `r1_model_pin`, `r6_thinking_rebinds`, `r7_reload_rebinds`, and
  `d2_resurrect_regates`. The run looks off because the selected model's
  thinking-level binding and resurrect tool-policy expectations did not match
  the harness assertions.

## Plan Updates

None. The new quota harness covers topic-specific behavior and does not add a
new primary journey to the persistent plan. J5 remains `driver: TBD`.

## Open Issues

- **Adjacent resume harness oracle:** `resume-restore/run.mjs` compares a
  status model that includes `:off` with a transcript model that does not. Its
  non-nested worker also spawned a child during a real LLM turn, making the
  subgroup assertion nondeterministic. The nested attempt timed out. This is
  an adjacent harness issue, not evidence of a quota-provider regression.
- **Adjacent model-tier harness:** `model-tiers/run.mjs` matches the first
  `| cheap |` rows in the generic prompt guidance, not the injected table. Its
  configured-spawn model observations were empty despite a successful catalog
  listing. Harden the parser and startup synchronization before treating J7 as
  green.
- **Adjacent persona harness:** five checks failed under the selected
  `gpt-4o-mini`/Gateway catalog combination. The failures concern thinking
  levels, prompt preamble matching, and resurrect tool re-gating. They need a
  separate investigation because this topic does not change persona behavior.
- **J5 has no driver:** worktree lifecycle remains untested by the persistent
  manual suite.
- **TUI-only surfaces:** the quota footer renderer and visual layout were not
  exercised in headless RPC mode. Status content was verified through RPC
  notifications.
