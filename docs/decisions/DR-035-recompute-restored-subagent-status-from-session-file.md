# DR-035: Recompute restored subagent status from the child session file

## Status
Accepted

## Context
On parent session resume, the subagents extension re-spawns children from
persisted session files. Every restored agent was seeded `state: "running"` with
zeroed usage/model/output, so the widget, panel, and `check_status` showed
stale/fabricated status until the child next ran a turn. Two ways to fix it were
available: (a) replicate usage/model/output into `PersistedAgentRecord` so restore
could read a snapshot from our own log, or (b) recompute those fields from the
child's own session JSONL at restore time. Separately, the resting `state` had to
be decided without coupling to the `session-resume` extension's idle-marker
protocol.

## Decision
Recompute, don't replicate. Parse the child's session file in a single forward
pass (`session-snapshot.ts`) to derive cumulative usage, last-message model/output,
and last-turn input; recompute `hasSubgroup` from the child's own persistence log.
No status fields are added to `PersistedAgentRecord`. Seed restored agents
`state: "idle"` and let the child's own `agent_start`/`agent_end` events drive
transitions — subagents never read the session-resume idle marker.

## Consequences
Single source of truth (the session file) — no drift between a replicated snapshot
and reality; extends DR-033's recompute philosophy. Cost is one extra forward pass,
strictly cheaper than the full replay the resumed child already does. The two
extensions stay decoupled: an idle-at-shutdown child stays idle (no events arrive),
a child with pending work auto-resumes and flips to `running` naturally.
Trade-off: restore now depends on the session file's on-disk format (parsed
directly, as `persistence.ts` already does), and the parser must tolerate
malformed/partial lines without throwing.
