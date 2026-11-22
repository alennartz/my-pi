# DR-070: Feature Map in Manual Testing

## Status
Accepted

## Context
The manual-testing phase keeps `tools/manual-test/PLAN.md`, a set of primary user journeys. Journeys answer "how do we exercise the high-value paths". Nothing in the persistent artifacts answers "what features exist, how users reach them, and what proves each one works". Answering that today means re-reading plans, per-topic artifacts, and test files from scratch on every run.

## Decision
Add `tools/manual-test/featuremap.md` as a second persistent artifact next to `PLAN.md`. One entry per user-facing feature: what it is, how users reach it, and what proves it works (a journey in `PLAN.md`, a tool, or a test). The phase bootstraps it on first run and updates it in the same pass as the plan: features arrive with the topics that ship them, entries refresh when reach or behavior moves, proof links land when a run produces evidence, and retired features leave.

Rejected folding the inventory into `PLAN.md`. Journeys and features differ in granularity. One journey can prove several features. One feature can span several journeys. Merging them bloats the focused journey list the cheap smoke pass depends on. Also rejected deriving the inventory fresh each run: that recreates the from-scratch cost DR-031 removed.

## Consequences
Every run ends with an explicit feature-to-evidence mapping. Unproven features show up as visible gaps instead of hidden assumptions. New runs start from the inventory instead of re-deriving it. The map adds curation load next to the plan. It stays useful only while entries track the product and the two files keep their division of labor: `PLAN.md` holds the drilled journeys, `featuremap.md` holds the full inventory.
