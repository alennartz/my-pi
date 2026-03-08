# DR-007: Artifacts as Pipeline State — No Tracker File

## Status
Accepted

## Context
The workflow pipeline needs to know where a topic stands (which phases are done, what's next). Could have used a dedicated status/tracker file, a database, or inferred state from what exists.

## Decision
Pipeline state is inferred entirely from which artifact files exist on disk. No brainstorm and no plan means starting fresh. Brainstorm exists but no plan means architecting is next. Plan with steps all done and no review means review is next. The existing artifact paths (`docs/brainstorms/<topic>.md`, `docs/plans/<topic>.md`, `docs/reviews/<topic>.md`) serve as the state thread.

## Consequences
No state synchronization problems — the artifacts *are* the state, so they can't drift from a tracker. One fewer file to manage. The LLM interprets the inventory and makes fuzzy semantic matches against topic names. Downside: state inference is heuristic (the LLM decides what the artifacts mean), but in practice the patterns are unambiguous.
