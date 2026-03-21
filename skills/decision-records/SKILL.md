---
name: decision-records
description: "Write and manage decision records (DRs). Owns the format, quality bar, numbering, supersession mechanics, and file conventions. Use standalone to capture a decision, or as a delegate from cleanup during pipeline extraction."
---

# Decision Records

## Overview

Write and manage decision records — permanent artifacts that capture non-obvious decisions, the alternatives considered, and the trade-offs that drove the choice. A DR exists to save future readers from re-deriving reasoning that would otherwise be lost.

## Quality

A decision record captures **why and how**, not **what**. It is not a feature description — it's a reasoning snapshot that preserves the logic behind a non-obvious choice when there were multiple competing options.

**A good DR:**
- Names the rejected alternatives and explains specifically why they lost — not just "we considered B" but "we rejected B because it required X, which was too expensive given Y"
- Articulates trade-offs: what got harder, what's constrained, what was knowingly given up
- Grounds itself in the reality at the time — the forces and constraints that shaped the choice
- Gives a future reader enough to re-evaluate the decision against changed circumstances — if the reasons no longer apply, they know exactly what to revisit
- Stays concise: a few sentences to a couple paragraphs of context, not a design document

**A bad DR:**
- Reads like a feature description — describes what was built, not why it was chosen
- Records the choice without recording the cost
- Mentions rejected alternatives without saying why they were rejected
- Has a consequences section that just restates the decision as benefits
- Captures something so obvious or narrow-scoped that the reasoning is already recoverable from code and git history alone

**The redundancy test:** a DR earns its existence when the reasoning would otherwise be lost — scattered across conversations, implicit in context that evaporated, or buried in trade-off analysis that never made it into code. If someone could reconstruct the reasoning from the code and git history in a few minutes, the DR is redundant.

If a draft doesn't meet this bar after incorporating available context, say so and ask the user to fill in the gaps. Don't ship a weak record.

## Format

```markdown
# DR-NNN: <Title>

## Status
Accepted

## Context
<Why this decision was needed — the forces at play, what prompted it.>

## Decision
<What was decided and why.>

## Consequences
<What follows from this decision — benefits, trade-offs, things to watch for.>
```

## File Conventions

- **Location:** `docs/decisions/DR-NNN-<slug>.md`
- **Numbering:** scan `docs/decisions/` for the highest existing `DR-NNN` prefix and increment. If the directory doesn't exist, create it and start at `DR-001`.
- **Slug:** kebab-case summary of the decision itself, not a topic or feature name.

## Supersession

When a new DR replaces an existing one:

1. Capture the old DR's last commit hash: `git log -1 --format=%H -- docs/decisions/DR-NNN-<slug>.md`
2. Delete the old DR file.
3. In the new DR's Context section, include a provenance line:

> Supersedes DR-NNN (<title>), deleted at commit `<hash>`.

If a superseded DR has no direct replacement (e.g., the decision was simply retired), the deletion is sufficient — no replacement DR is needed.

## Proposal Flow

1. **Propose one DR at a time.** Present the title, a brief summary of the context, and what was decided.
2. **The user approves, edits, or rejects.** Incorporate edits, move on from rejections.
3. **Write approved records** to `docs/decisions/` following the file conventions above.

**Zero is a valid answer.** Don't manufacture a DR just to have one.
