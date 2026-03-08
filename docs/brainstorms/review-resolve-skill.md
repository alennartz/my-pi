# Brainstorm: Review Resolve Skill

## The Idea

A skill that takes review findings and acts on them — fixing what's clearly correct, and escalating what's ambiguous to the user. Sits between the code-review skill and the next action. Goal is to make the implement → review → fix loop mostly hands-off.

## Key Decisions

### Semi-autonomous: fix confident, escalate ambiguous
The skill fixes findings where both the diagnosis and the fix are unambiguous. If either the problem or the solution is debatable, it escalates to the user. The line isn't about categories of findings — it's about confidence.

### Confident fixes first, then escalate
Do all the confident fixes first, commit them, then present any remaining ambiguous findings as a batch for the user to decide on. The user gets the easy wins immediately and only spends time on things that need their judgment.

### Direct fixes, no plan cycle
Review findings are typically small and surgical — add missing error handling, add missing validation, fix a logic error. The skill makes changes directly and commits, no architect → plan → implement pipeline. If something is big enough to warrant a plan, it's an escalation.

### Updates the review file
As findings are resolved, the skill marks them as resolved in the review file. This keeps the review artifact accurate as a record of what was found and what was done about it.

## Direction

Build a `review-resolve` skill that:
1. Reads the review file (`docs/reviews/<topic>.md`) and the plan
2. Reads the codemap for context
3. For each finding, assesses confidence: is the diagnosis clear AND is the fix unambiguous?
4. Makes all confident fixes, commits them, marks those findings resolved in the review file
5. Presents any remaining ambiguous findings to the user for decision

## Open Questions

- Exact format for marking findings as resolved in the review file (e.g., status field, strikethrough, separate section)
- What happens after the user decides on ambiguous findings — does the skill then fix those too, or does the user handle it themselves?
- Naming: `review-resolve`, `review-triage`, `resolve`, or something else
