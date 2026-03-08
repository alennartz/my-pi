# DR-009: Ephemeral Working Artifacts with Decision Record Extraction

## Status
Accepted

## Context
The workflow pipeline produces brainstorms, plans, and reviews as working artifacts. Left to accumulate, they become stale clutter that misleads rather than informs. But they contain decisions worth preserving — trade-offs considered, approaches rejected, architectural choices with reasoning.

## Decision
Working artifacts (brainstorms, plans, reviews) are ephemeral — deleted at the end of each workflow. Before deletion, a cleanup phase scans them for decisions that clear a "would this matter six months from now" bar and extracts those into permanent decision records (`docs/decisions/DR-NNN-<slug>.md`). The user reviews each proposed record individually (approve, edit, reject). The cleanup phase also sweeps user-facing docs for staleness and refreshes the codemap.

## Consequences
The docs directories stay clean — only in-progress work and permanent records. Valuable reasoning survives the artifact deletion in a durable, indexed format. The user stays in the loop on what gets preserved. The higher extraction bar prevents decision record bloat — not every choice becomes a DR, only ones with substantive reasoning behind them.
