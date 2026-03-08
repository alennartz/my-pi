# Cleanup Skill — Brainstorm

## The Idea

A new skill that serves as the final phase of the workflow pipeline (after handle-review). Its purpose is to close out a completed workflow by extracting lasting value from working artifacts, refreshing project documentation, and then cleaning up the temporary files so they don't accumulate forever.

## Key Decisions

### Decision records instead of ADRs
We considered classic ADRs but generalized to "decision records" (DRs). Many decisions captured in working artifacts aren't architectural — they're scope decisions, workflow conventions, design trade-offs. The ADR pattern (title, status, context, decision, consequences) fits all of these, so we use the same format but under a broader label. Stored in `docs/decisions/` with numbered format `DR-NNN-<slug>.md`.

### User reviews each decision record individually
The agent proposes decision records one at a time for user approval/edit/rejection. This keeps noise out — only decisions that would matter to someone six months from now get captured. If the user rejects all proposed records, the skill proceeds normally; the extraction step is a no-op and working artifacts still get deleted. The user had their chance to preserve what mattered.

### Higher bar for extraction
Not every choice in a brainstorm or plan is worth preserving. The bar is: would this matter to someone working in this codebase six months from now? Trivial or mechanical decisions don't get proposed.

### Light codemap refresh, not full rebuild
The codemap already gets updated during implementation while context is fresh. The cleanup skill just does a light pass to catch anything that changed during review/handle-review. Not a full rebuild.

### Open-ended documentation pass
The skill doesn't prescribe which docs to check. It discovers what user-facing documentation exists in the repo (READMEs, AGENTS.md, codemap, whatever else) and checks whether anything that shipped makes them stale. The agent uses judgment for discovery — no hardcoded list.

### Always runs in clean context
The cleanup skill always starts in a fresh session with no conversational context from earlier phases. It reconstructs everything it needs from the artifacts on disk. Skill instructions must be self-contained about what to read and where to find things.

### Only runs after full pipeline completion
Cleanup is the cap on a completed workflow, not a standalone tool. It assumes brainstorm → architect → plan → implement → review → handle-review have all run.

## Direction

The cleanup skill is the 7th and final phase of the workflow pipeline. It runs in a clean context and performs four steps in order:

1. **Extract decision records** — Read all working artifacts (brainstorm, plan, architect, review) for the topic. Identify decisions that clear the "six months from now" bar. Propose each to the user one at a time for approval/edit/rejection. Write approved records to `docs/decisions/DR-NNN-<slug>.md` continuing from existing numbering.

2. **Codemap refresh** — Light pass on the codemap to account for changes made during review/handle-review.

3. **Documentation pass** — Open-ended sweep of user-facing docs in the repo. Update anything made stale by the completed work.

4. **Delete working artifacts** — Remove `docs/brainstorms/<topic>.md`, `docs/plans/<topic>.md`, `docs/reviews/<topic>.md` for the completed topic.

## Open Questions

- None identified.
