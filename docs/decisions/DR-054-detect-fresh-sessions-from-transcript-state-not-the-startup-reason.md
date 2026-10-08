# DR-054: Detect fresh sessions from transcript state, not the `session_start` reason

## Status
Accepted

## Context
Extensions that distinguish "fresh session" from "continuation" (to decide whether to re-bind or announce) reach for pi's `session_start` reason vocabulary — and it lies. pi dispatches reason `startup` for CLI-opened *existing* sessions (`pi --session <existing>`); `resume` is dispatched only for in-process session switches. This trap shaped and then misled persona-workspaces' binding logic: the first implementation keyed "fresh" on the reason set and rebound a persona over the user's mid-session choices at every CLI resume, against the ruling's intent — fixed only after a live manual run exposed it. Any extension classifying session freshness by the reason set alone inherits the same bug.

## Decision
Freshness is determined from the session's own state — whether it opens over a lived-in transcript (and its parent/branch lineage) — never from which reason was dispatched. The reason is retained at most as supporting lifecycle state; anything once-per-session (takeover announcements) dedups against the transcript itself rather than a separate notice registry, so a fork — which copies the parent's branch — inherits the dedup for free.

Rejected: treating `startup` as fresh (demonstrably wrong — it covers CLI resumes of existing sessions); treating `resume` as the only continuation signal (it never fires for CLI opens); a persistent in-memory notice registry keyed per session (goes stale across resume/reload and forks; the transcript already is the record); trusting dispatch order as invariant ("`session_start` always precedes the first run") — that is the same class of assumption that produced the original bug.

## Consequences
Freshness logic survives pi dispatch quirks and future reason additions. Cost: the remedy is local — every extension with fresh-vs-continuation logic must implement transcript-derived detection; there is no shared pi primitive. Known residual risk (accepted): an unrecorded reason defaults to fresh-and-announce in the current implementation, which is biased toward announcing rather than silence if dispatch order ever changes; transcript dedup backstops it in practice.
