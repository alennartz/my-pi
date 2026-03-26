# Plan Blind Spot Check

## The Idea

The code-review skill is plan-anchored — it checks whether the implementation matches the plan. But when the plan itself has a gap (e.g., the brainstorm intended to remove group framing everywhere, but the plan didn't include updating skills that reference group concepts), the review can't catch it. The gap originates at plan time, so the fix should live there too.

## Key Decisions

### Fix at plan time, not review time

Gaps between intent and plan steps are cheapest to catch before implementation. A review finding for "you missed updating skills" becomes a plan step instead — the implementer just does it. The review skill stays cleanly plan-anchored, which is a simpler contract.

### Subagent reads brainstorm + plan and looks for blind spots

After the plan is written, spawn a subagent with the brainstorm and the completed plan. Its task is narrow: "what did the brainstorm intend that the plan doesn't cover?" It's not replanning or reviewing quality — it's specifically comparing intent against coverage. The scoped question keeps output actionable rather than noisy.

### Only runs when a brainstorm exists

Not every pipeline has a brainstorm — some start at architect or plan. The blind spot check compares intent (brainstorm) against steps (plan), so without a brainstorm there's nothing to compare. It simply doesn't run.

### Findings surface as a conversation with the user

The blind spot agent's output goes to the planner, who surfaces substantive findings to the user. The user decides what gets added — "yes add a step," "no that's already covered by step N," or "not worth it." The plan is already user-approved at that point, so modifying it silently based on a subagent's suggestions would overshoot.

## Direction

Add a final step to the planning skill, after the plan is written but before the final commit:

1. If `docs/brainstorms/<topic>.md` exists, spawn a subagent with the brainstorm content and the completed plan
2. Subagent identifies intent from the brainstorm that the plan doesn't cover
3. Planner reviews the output and surfaces anything substantive to the user
4. User decides what (if anything) becomes new plan steps
5. Then commit

## Open Questions

None — the scope is narrow and the mechanics are straightforward.
