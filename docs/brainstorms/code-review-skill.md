# Brainstorm: Code Review Skill

## The Idea

A skill that reviews code changes against the plan that produced them. Primary use case: you've just finished implementing something (typically via the implement skill) and want a rigorous review before pushing. Should also work for reviewing others' changes or pointing at arbitrary code, but the plan-grounded review is the core.

## Key Decisions

### Review is plan-grounded, not generic
The plan file is the spec. The review asks "did we build what we said we'd build?" rather than offering generic code feedback. This gives it a concrete reference point and makes findings actionable.

### Two-pass review
1. **Plan adherence** — compare the plan's intent and steps against the actual diff. Flag meaningful deviations and incomplete work.
2. **Code correctness** — look at the code itself for bugs, unhandled errors, resource leaks, race conditions, off-by-one errors, etc.

Plan adherence first, correctness second. Both feed into the same findings list.

### Uses judgment on deviations
Not pedantic. Reasonable adaptations (method name slightly different than assumed, extra edge case handled) are fine. Meaningful drift (planned validation missing entirely, wrong module touched) gets flagged.

### Scope via git diff from a starting commit
The implement skill stamps the current HEAD commit hash into the plan file before it starts working (new field: `pre-implementation-commit`). The review skill diffs from that commit to HEAD. Combined with the plan and codemap in context, this naturally covers both "what changed" and "what should have changed."

### Findings go to a separate file
Output to `docs/reviews/<topic>.md`. Keeps the plan file clean as a single-purpose artifact. Supports multiple review rounds (`<topic>-1.md`, `<topic>-2.md`). No mixing of planned work with review patches.

### Finding format
Each finding includes:
- **Category** — plan deviation or code correctness
- **Severity** — critical / warning / nit
- **Location** — file and relevant lines
- **Description** — what's wrong and why it matters

### Fully autonomous, no interactive checkpoints
Reads the plan, reads the diff, produces the report in one pass. User reads findings and decides next steps.

### Findings don't prescribe a follow-up process
The review skill produces findings and stops. Whether fixes warrant a new plan cycle or just a quick manual fix is the user's call.

## Direction

Build a `code-review` skill that:
1. Reads the codemap and the plan file (including the `pre-implementation-commit` hash)
2. Gets the diff from starting commit to HEAD
3. Runs plan adherence pass, then code correctness pass
4. Writes findings to `docs/reviews/<topic>.md`

Requires a small change to the implement skill: stamp `pre-implementation-commit` into the plan file before starting work.

## Open Questions

- Exact format/structure of the review output file (beyond per-finding fields)
- How to handle the case where no plan exists (reviewing arbitrary code or someone else's PR) — likely a degraded mode that skips the plan adherence pass
- Whether the implement skill change (stamping commit hash) should be done first as a prerequisite
