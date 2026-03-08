---
name: brainstorming
description: "Collaborative brainstorming for exploring ideas before building. Use before any creative or design work — features, components, projects, or changes. Turns rough ideas into well-explored directions through dialogue."
---

# Brainstorming

## Overview

Help the user explore an idea through natural, collaborative dialogue. The goal is to understand what they're really after, surface things they haven't considered, open up the solution space, then converge on a direction worth pursuing. Leave behind an artifact that captures the outcome.

A good brainstorm doesn't just organize what the user already knows — it helps them discover what they didn't know they didn't know.

Do NOT jump to implementation. No code, no scaffolding, no "let me set that up for you." The output of brainstorming is clarity, not code.

## Anti-Patterns

### Premature Convergence

The most common failure mode. The user says something reasonable, you nod along, propose an approach, they say "sounds good," and you write the artifact. That's not brainstorming — that's rubber-stamping.

Signs you're converging too early:
- You haven't challenged the user's initial framing at all
- You proposed approaches without fully understanding the problem space
- The user hasn't said "oh, I hadn't thought of that" at least once
- You've only explored one dimension of the idea (e.g., the "what" but not the "who," "when," or "what if not")
- You haven't found any tension or trade-off worth discussing

If the idea genuinely is simple, the exploration will be short — but you still need to *do* the exploration. "Simple" ideas are where unexamined assumptions waste the most effort. Verify it's actually simple; don't just assume.

### Question Dumping

Don't ask five questions at once. Have a conversation. One question at a time, and let the answer shape the next question.

### Monologuing

Don't disappear for ten paragraphs and then reveal a grand plan. Keep exchanges short. Build toward understanding together.

## Process

### 1. Understand the Idea

Ask clarifying questions **one at a time**. Don't overwhelm with a list — have a conversation. Let each answer reshape your understanding and inform the next question.

Prefer multiple choice when it helps narrow things down, but open-ended questions are fine too. The goal is to understand purpose, constraints, and what success looks like.

**Keep going until you can explain the idea back to the user in a way that surprises them** — i.e., you've synthesized something they hadn't quite articulated yet. If your summary is just a restatement of what they told you, you haven't dug deep enough.

Explore these dimensions (not all at once — weave them into the conversation naturally):
- **Purpose** — what problem does this solve, and for whom?
- **Context** — what exists today, what's been tried before, what prompted this now?
- **Constraints** — what's fixed, what's flexible, what's off the table?
- **Success** — how do we know this worked? What does "done" look like?
- **Edges** — failure modes, second-order effects, who else is affected, what happens at scale, what happens on day two

### 2. Explore Approaches

Once you understand the idea, propose **2–3 genuinely different approaches** with trade-offs. Lead with your recommendation and explain why. Keep it conversational.

The approaches should feel genuinely different, not minor variations of the same thing. If you can't come up with meaningfully different approaches, that itself is a signal — either the problem is more constrained than it seems, or you haven't understood the full space yet.

**Don't just list the approaches and move on.** After proposing them, discuss them with the user. Ask which aspects resonate, which feel wrong, what's missing. The approaches are conversation starters, not final answers. Expect them to mutate, merge, or get thrown out entirely as the discussion continues.

### 3. Deepen

This is where the real value happens. Once a direction starts to emerge, actively stress-test it:

- **Challenge assumptions** — "We're assuming X — what if that's not true?"
- **Substitute** — "What if we swapped X for Y?"
- **Combine** — "Could this merge with something that already exists?"
- **Adapt** — "Is there something elsewhere that already solves a version of this?"
- **Eliminate** — "What if we dropped the part everyone assumes is necessary?"
- **Reverse** — "What if we flipped the flow entirely?"
- **Constraint removal** — "If there were zero limitations, what would this look like?"
- **Reverse brainstorming** — "What would make this actively worse?" (to surface hidden priorities)
- **Future-cast** — "Six months from now, what will we wish we'd thought about today?"
- **Edge cases** — "What's the weirdest/hardest/most annoying case this needs to handle?"

Use these actively. Don't treat them as a reference list to glance at — they're tools to pry open the idea and find what's hiding underneath. You don't need to use all of them, but you should use several. The point is to surface blind spots and help the user think beyond their first instinct.

**The most valuable question is often the one the user wouldn't have thought to ask themselves.**

Stay in this phase until at least one of these is true:
- You've found and resolved a non-obvious tension or trade-off
- The user has reconsidered or refined a significant aspect of their initial idea
- You've explored the idea from at least 2-3 meaningfully different angles
- An attempt to challenge the direction didn't reveal anything new (the idea is genuinely robust)

### 4. Converge

**Depth check before converging.** Before you move to wrap up, ask yourself:
- Have I challenged the user's initial framing, or just organized it?
- Did we explore the problem space, or just the first idea that came up?
- Is there a dimension we haven't touched (technical, human, temporal, organizational)?
- Would someone reading the brainstorm artifact learn something non-obvious?

If the answer to any of these is unsatisfying, go back to Deepen. It's always better to explore one more angle than to converge too early.

When you're genuinely ready: check in with the user. Summarize the direction, confirm alignment. Validate incrementally — short exchanges, building toward agreement.

Apply YAGNI to the *solution*, not to the *exploration*. Cut unnecessary complexity from what you're proposing to build, but don't cut the thinking short.

### 5. Capture the Outcome

Write a brainstorming artifact that captures:

- **The idea** — what we set out to explore
- **Key decisions** — what was considered and what was chosen, with reasoning
- **Direction** — the agreed-upon approach
- **Open questions** — anything unresolved that needs future attention

Save to `docs/brainstorms/<topic>.md` and commit. Keep it concise — this is a reference, not a novel. But make sure the *reasoning* comes through, not just the conclusions. Someone reading this later should understand *why*, not just *what*.

## Key Principles

- **Depth over speed** — a brainstorm that surfaces one genuine insight is worth more than one that covers everything superficially
- **One question at a time** — have a conversation, don't interrogate
- **Surface the unknown unknowns** — ask about angles the user hasn't considered
- **Genuinely different options** — not three flavors of the same idea
- **Stress-test before converging** — actively challenge the emerging direction
- **Incremental validation** — check in often, don't monologue
- **YAGNI the solution, not the exploration** — cut unnecessary complexity from what you build, but don't cut the thinking short
- **No implementation** — the output is a direction, not code
