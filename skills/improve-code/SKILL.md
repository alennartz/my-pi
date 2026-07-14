---
name: improve-code
description: "Scan a codebase for deepening opportunities, present them as a visual HTML report, then work through whichever one the user picks."
disable-model-invocation: true
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

Read the **codebase-design** skill first for the vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) and its principles (the deletion test, "the interface is the test surface", "one adapter = hypothetical seam, two = real"). Use these terms exactly in every suggestion — don't drift into "component," "service," "API," or "boundary." The domain language in `glossary.md` (if present) gives names to good seams; decision records in `docs/decisions/` record decisions this skill should not re-litigate.

## Process

### 1. Explore

**Scope before you scan — YAGNI.** Deepening a module pays off by making future changes to it easier, so put extra weight on the parts of the codebase that have recently changed. Decide *where* to look before you look:

- If the user named a direction — a module, a subsystem, a pain point — take it.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline`) to find the codebase's hot spots — the files and areas that keep coming up — and let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.

Read `glossary.md`, the codemap, and any relevant decision records first.

Then walk the codebase — delegating to subagents when the scan is large enough to burn meaningful context. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML report — nothing lands in the repo. If the session provides a way to present rendered HTML to the user (a hosting or preview tool), use it; otherwise write to the OS temp directory, open it with the platform opener (`xdg-open`/`open`/`start`), and tell the user the absolute path.

Presentation is yours to design — responsive, legible, visual. CDN assets (e.g. Tailwind, Mermaid) are fine. Each candidate gets a card covering:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **Before / After** — a visualisation of the shallowness and the deepening
- **Recommendation strength** — `Strong`, `Worth exploring`, or `Speculative`

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

**Use glossary.md vocabulary for the domain, and the codebase-design vocabulary for the architecture.** If the glossary defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**DR conflicts**: if a candidate contradicts an existing decision record, only surface it when the friction is real enough to warrant revisiting the DR. Mark it clearly in the card (e.g. _"contradicts DR-007 — but worth reopening because…"_). Don't list every theoretical refactor a DR forbids.

Do NOT propose interfaces yet. After presenting the report, ask the user: "Which of these would you like to explore?"

### 3. Work the chosen candidate

Once the user picks a candidate, walk its decision tree conversationally — one question at a time, each with your recommended answer: constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize — run the **domain-modeling** skill to keep the glossary current as you go:

- **Naming a deepened module after a concept not in `glossary.md`?** Add the term. Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `glossary.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer a decision record via the **decision-records** skill, framed as: _"Want me to record this so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer — skip ephemeral reasons ("not worth it right now") and self-evident ones.
- **Want to explore alternative interfaces for the deepened module?** Use the codebase-design skill's design-it-twice parallel subagent pattern.

The outcome of this loop is a direction — hand off to the architecting phase (or a full pipeline run) to turn it into a plan.

---

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `improve-codebase-architecture` (MIT).
