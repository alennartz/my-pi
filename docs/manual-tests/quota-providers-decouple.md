# Manual Testing — quota-providers-decouple

## Smoke Suite

This run covers the changed provider and quota paths plus adjacent startup
journeys. It exercises J1/J2 (child startup and teardown/resurrection use the
same provider registry), J4 (this manual-testing phase), J6 (resume with
provider extensions), J7 (model-tier startup against the new provider), and
J8/J9 (persona harnesses now configured for `llmgateway`). J3 and J5 remain
outside this change and keep their existing `driver: TBD` status in the
persistent plan.

## Topic-Specific Tests

- **Provider-ID quota attachment** — configure a quota source against a
  complete provider ID, keep an unattached provider beside it, and verify only
  the named provider receives the guard. This is the central decoupling path.
- **Complete-provider stream boundary** — drive an allowed request and a
  blocked request through a local complete provider. Verify the blocked request
  fails before transport and the allowed request preserves provider behavior.
- **Tree-scoped bypass and `/quota`** — toggle bypass in the live session and
  verify the soft-cap decision changes while the status command remains
  provider-scoped.
- **Usage-source persistence** — run the executable usage runner with a
  deterministic source. Verify one cache record contains snapshots and the
  opaque model-to-limit map, and that covered ledger entries are pruned.
- **LLM Gateway provider split** — start a real pi process with the
  `llmgateway` extension and inspect its resolved provider/model state. When
  credentials and a live catalog are available, exercise a refresh; otherwise
  record the prerequisite limitation without claiming a live pass.

## Tools

- Reused: `tools/manual-test/resume-restore/run.mjs`,
  `tools/manual-test/model-tiers/run.mjs`, and
  `tools/manual-test/persona-workspaces/run.mjs` for adjacent smoke paths.
- New: `tools/manual-test/quota-providers/run.mjs` — a parameterized RPC and
  runner harness using a local complete provider and deterministic quota source.

## Harness Limitations

The new quota harness uses a local provider and deterministic usage source, so
it does not exercise LLM Gateway transport, real account windows, or network
failure behavior. The live Gateway catalog check uses the real API only when
`LLMGATEWAY_API_KEY` and a suitable catalog are available. Headless RPC does
not render the TUI footer; it checks command notifications and provider
requests instead. The existing adjacent harnesses use real LLM calls and can
fail or incur cost when credentials or model prerequisites are unavailable.

## Results

_To be filled after the harnesses run._

## Plan Updates

None planned before execution.

## Open Issues

_To be filled after the harnesses run._
