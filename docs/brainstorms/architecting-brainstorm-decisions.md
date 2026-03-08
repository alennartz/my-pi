# Brainstorm: Architecting Skill — Respect Brainstorm Decisions

## The Idea

The architecting skill re-asks about sub-decisions that the brainstorm already resolved, even when nothing new has come up that would change them. This makes the brainstorm feel pointless and slows down the architect phase with redundant questions.

## Key Decisions

- **The problem is about *when*, not *how*.** The way the architect raises conflicts is fine. The issue is purely that the threshold for re-opening a decided question is effectively zero — anything on its decision checklist gets re-asked. The threshold should be: "I found something in the code that undermines the reasoning behind this decision."

- **Use the brainstorm's own structure.** The brainstorm artifact already separates "key decisions" (with reasoning) from "open questions." The architect should treat these differently: decisions are settled starting points, open questions are fair game for discussion.

- **The "why" is the judgment anchor.** In a fresh context, the agent can't remember the brainstorm conversation — but the artifact captures the reasoning behind each decision. The agent should check whether the code investigation contradicts that reasoning. If the reasons still hold, the decision still holds. If the code undermines the *why*, that's the signal to revisit.

- **Both failure modes matter.** Relitigating decided things for no reason (current problem) and silently accepting decisions the code can't support (potential overcorrection) are both bad. The fix addresses both: don't re-ask unless you found something new, but if you did, explain what you found before asking.

## Direction

Two touch points in the architecting skill:

1. **Step 0 (Check for Context)** — where the brainstorm is read. Establish that decisions are settled starting points and open questions are fair game.
2. **Step 2 (Decide, One at a Time)** — where decisions are walked through. Make the rule explicit: don't re-ask decided things unless the code investigation contradicts the reasoning behind the decision. When revisiting, explain what was found and why it impacts the original reasoning.

## Open Questions

- None.
