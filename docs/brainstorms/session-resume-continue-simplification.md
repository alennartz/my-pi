# Brainstorm: Session resume continue simplification

## Idea

Drastically simplify the session-resume extension by removing custom marker/state tracking and relying on SDK-level resume behavior. The goal is that resumed sessions naturally continue running without bespoke logic that inspects prior message state.

## Key Decisions

- **Delete marker-based logic entirely.**
  - Remove `session-idle` and `session-resumed` custom entry strategy.
  - Rationale: it adds complexity and is no longer needed for the intended behavior.

- **Always attempt continuation when applicable.**
  - On eligible session starts, call `session.continue()` unconditionally.
  - Rationale: SDK behavior is expected to no-op when continuation is unnecessary.

- **Scope continuation to specific start reasons.**
  - Run on `session_start.reason` in `{ "startup", "resume" }`.
  - Do not run on `new`, `fork`, or `reload`.
  - Rationale: these are the flows where resuming prior in-flight work is desired, while other flows should remain unaffected.

- **Treat historical marker entries as harmless legacy data.**
  - No migration/cleanup for existing sessions containing old custom entries.
  - Rationale: keep rollout simple; legacy entries can remain inert.

## Direction

Implement a minimal resume extension path focused on reason-gated continuation only, with the old marker system removed.

## Open Questions

- Confirm the cleanest integration point for invoking `session.continue()` from extension code in this repo’s runtime wiring (without reintroducing complexity).
