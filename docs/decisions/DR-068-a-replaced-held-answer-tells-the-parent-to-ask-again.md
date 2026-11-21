# DR-068: A Replaced Held Answer Tells the Parent to Ask Again

## Status
Accepted

## Context
A view holds a child's result while a lease is attached (DR-067), and the last detach delivers the latest held result. Replacing a held result is intended: the child's next run starts from what the user just told it, so the newest result is the useful one.

The cost falls on the parent. An orchestrator that awaited a result may receive a result the user's conversation produced instead of the child's answer. The child cannot mark its output, so no mechanical test separates "this result answers the parent" from "this result answers the user". Losing the awaited answer silently is the failure that follows, because the parent reads whatever arrives as its answer.

## Decision
The await gate records when a settlement displaces a held result that no delivery reported yet. The replacement settlement carries that fact, and both delivery paths render it as a note inside `<agent_idle>` telling the parent the result may not be the awaited one and to ask the child to repeat what it meant to send.

Three cases do not carry the note, because the parent lost nothing:
- A settlement the parent already received, re-held by a view opened after delivery.
- A held stop, which delivered nothing on purpose (DR-067).
- A parent stop, which discards held results and ends the wait.

The note states a possibility, not a certainty: a result that replaces a held one may still be the awaited answer, because a child can finish twice. The parent decides whether to ask again, and the ask costs one round trip.

Rejected: detect when a result answers the user rather than the parent. Nothing in the run records the recipient of an output, so any such test would guess.

Rejected: drop the replacement settlement so the parent never reads a wrong answer. The parent then learns nothing and waits for a result that will not come.

## Consequences
Every replacement delivery pays a note, so a parent that watches results closely reads a caveat it may not need. A parent that ignores the note keeps the current behavior: a wrong answer with no signal that anything was lost.

The gate now tracks whether a held settlement reached delivery, so `attach` after a delivery no longer marks the settlement it re-holds as unreported.
