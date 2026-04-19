# DR-031: Manual-Testing Phase with Persistent Smoke Suite

## Status
Accepted

## Context
The pipeline closed at handle-review, which only verified that review findings were resolved. Nothing exercised the shipped artifact the way a human would. Automated tests check component contracts but routinely miss breakage of primary user journeys, especially for small changes that skip upfront test-writing. The outer loop was open.

The naive fix — a per-topic manual-test phase that enumerates journeys and builds tools from scratch every run — is too expensive to run consistently, and the gate against "this change is too small to be worth testing" would be set high, which is exactly backwards: small changes are where silent breakage sneaks in.

## Decision
Insert a `manual-test` phase between handle-review and cleanup. The phase maintains a **persistent** manual test plan at `tools/manual-test/PLAN.md` and a reusable tool collection at `tools/manual-test/`, bootstrapped on first run and grown incrementally. Per-run cost is a cheap smoke pass over the persistent plan plus any topic-specific additions. The phase fixes straightforward failures inline and escalates only architectural, high-complexity, or ambiguous ones.

Rejected alternative: a front-loaded skip decision tied to the existing "skip to implement" tier. Rejected because small changes are precisely the regressions manual-testing catches, and the cost argument evaporates once the suite is amortized. Skip is retained only for docs-only changes and genuine capability gaps (can't exercise in-environment) — the latter surfaced to the user explicitly rather than silently swallowed.

## Consequences
Cost is front-loaded into the first run in any given repo; subsequent runs are cheap. `tools/manual-test/` becomes a permanent repo module that cleanup's codemap refresh must own. The phase's value depends on curation discipline — if `PLAN.md` bloats beyond primary journeys, the smoke pass becomes expensive and the amortization argument breaks. Manual-test inherits autoflow's escalation posture; structural failures that surface here loop back to earlier phases rather than getting patched inline.
