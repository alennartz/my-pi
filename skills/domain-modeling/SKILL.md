---
name: domain-modeling
description: "Build and sharpen a project's domain language. Use when the user wants to pin down terminology, when terms in a design conversation are fuzzy, conflicting, or overloaded, or when another skill needs the glossary maintained during a session."
---

# Domain Modeling

Actively build and sharpen the project's domain language as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary down the moment a term crystallises. (Merely *reading* `glossary.md` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the language, not just consuming it.)

The payoff compounds: a shared language means one word where twenty would do, consistent names in code and docs, and an agent that navigates the project by its real concepts.

## The artifact

`glossary.md` at the repo root, adjacent to `codemap.md`. It is a glossary and nothing else — canonical terms, tight definitions, rejected synonyms, term relationships. Format: [FORMAT.md](FORMAT.md).

Create it lazily — only when the first term is resolved. When you create it, also add a reference line to the project's `AGENTS.md`, alongside its codemap reference:

```markdown
See [glossary.md](./glossary.md) for the project's domain language — use its terms in code, docs, and conversation.
```

Neighboring conventions, so content lands in the right file: `codemap.md` owns structure (what lives where), `glossary.md` owns language (what things are called), decision records own decisions (why things are the way they are).

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `glossary.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update glossary.md inline

When a term is resolved, update `glossary.md` right there. Don't batch these up — capture them as they happen.

### Offer a decision record sparingly

Only offer to create a decision record when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip it. When all three hold, follow the **decision-records** skill — it owns format, numbering, and file conventions.

## Bootstrapping an existing repo

When a repo predates its glossary, the latent language already lives in the code — harvest it, don't invent it. But never bulk-extract: a mechanical dump of identifiers produces exactly the sediment the format rules forbid.

1. **Harvest candidates.** Scan the code and docs for the project's recurring concepts: core type and module names, terms in README and docs, words with multiple names for the same thing, names whose meaning surprised you. Collect candidate terms — project-specific concepts only, not general programming vocabulary.
2. **Grill one term at a time.** For each candidate, propose a canonical name, a one-to-two-sentence definition, and the synonyms to avoid — then let the user rule. Where the code itself disagrees on a name, surface the conflict and let the user pick the winner.
3. **Write as you go.** Each ruled term goes into `glossary.md` immediately, following [FORMAT.md](FORMAT.md).

Done when every candidate is ruled in, ruled out, or explicitly parked as a flagged ambiguity.

---

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `domain-modeling` (MIT).
