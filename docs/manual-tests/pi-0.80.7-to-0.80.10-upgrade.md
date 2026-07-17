# Manual Testing — pi-0.80.7-to-0.80.10-upgrade

## Smoke Suite

Scoped subset of `tools/manual-test/PLAN.md`, selected because this upgrade changes
child-session runtime construction and model registration. The unrelated workflow
and worktree journeys are outside the supplied focus; the workflow phase is being
exercised by producing this artifact.

- **J1 — Subagent lifecycle: spawn, message, teardown.** A fresh child must start
  under its own SDK services, exchange a message, become idle, and tear down cleanly.
  Driver: the live parent session's direct tool surface.
- **J2 — Subagent resurrect.** A torn-down child must restore its saved conversation
  and tool policy under a newly constructed runtime. Driver: direct tool surface.
- **J3 — Fork.** A fork must inherit parent context, complete independently, and
  report through the normal lifecycle notification. Driver: direct tool surface.
- **J6 — Parent session resume.** Restart recovery must restore an idle child with
  faithful persisted status after a new runtime generation. Driver:
  `tools/manual-test/resume-restore/run.mjs`.
- **J7 — Model-tier selection.** Spawn-time model resolution must still work through
  the child-local runtime, including configured tiers, raw IDs, and fallback. Driver:
  `tools/manual-test/model-tiers/run.mjs`.

## Topic-Specific Tests

- **Child quota-provider model registration.** Configure a controlled quota-provider
  implementation that publishes a model, then have a real child session select that
  model at spawn. This directly verifies that child-scoped extensions register their
  provider with the child `ModelRuntime` before `config.modelRef` is resolved. Driver:
  a reusable real-Pi RPC harness to be added under `tools/manual-test/`.
- **Registration failure boundary.** Exercise an unavailable quota-provider model
  reference and preserve the user-visible spawn failure, rather than silently falling
  back to a parent runtime or default model. Driver: the same harness.

## Tools

- Reused: direct tool driver; `resume-restore`; `model-tiers`.
- New: pending assessment of the reusable quota-provider registration driver.
- Improved: none.

## Harness Limitations

The live direct-tool calls exercise the active in-process Pi session, while the
existing RPC drivers start real top-level Pi processes rather than a terminal-owned
interactive TUI. They can observe tool envelopes, persisted session data, and
`check_status`, but not widget/panel rendering, keyboard interaction, or concurrent
multi-parent races. The controlled quota-provider setup will use a local implementation
and ambient provider credentials only to make real model calls; it cannot validate a
third-party provider's network/auth behavior. These gaps do not weaken this topic's
primary runtime-construction, model-registration, spawn, resume, or fork behaviors.

## Results

Pending execution.

## Plan Updates

Pending execution.

## Open Issues

Pending execution.
