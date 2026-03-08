# DR-011: Superseded DRs Are Deleted, Not Marked

## Status
Accepted

## Context
When a decision record is superseded by a new one, the project needed a strategy for the old DR: keep it with a status change (e.g., "Superseded"), or delete it entirely.

## Decision
Superseded DRs are deleted from `docs/decisions/`. The new DR includes a provenance line with the old DR's number and last commit hash for traceability. Historical reasoning is recoverable from git.

## Consequences
`docs/decisions/` is always a trustworthy set of current decisions — no risk of the agent reading stale DRs and following them despite filtering instructions. Zero ambiguity. Trade-off: requires git history access to recover old reasoning, but the provenance line in the replacement DR points directly to the relevant commit.
