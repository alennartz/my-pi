# Reference Study

Pick 2-3 existing products in adjacent territory, study what specifically works there, and adapt — don't copy. Reference picks are the single highest-leverage decision in the brief: they ground every aesthetic call afterward in something the user can compare against.

## Why this matters

You are not going to invent a visual language from first principles inside a single brief, and you shouldn't try. Every successful product UI sits in a lineage. Your job is to:

1. Place the product in its lineage explicitly ("this sits in the territory of Linear / Stripe / Notion").
2. Pull specific, named moves from each reference ("Linear's command palette pacing" / "Stripe's secondary text color discipline" / "Notion's empty-state composition").
3. Adapt those moves to *this* product's context, audience, and constraints.

Stating the references in the brief lets the user (and any implementer) verify your direction at a glance. "Looks like a quieter Linear with Stripe-class type" is faster to confirm than 800 words of palette and typography rationale.

## Picking references

**Two or three. Not more.** Six references is research, not direction. Three is the maximum because it forces you to commit. The goal is "this product lives in this neighborhood," not "this product has touched every neighborhood."

**Pick from adjacent territory, not literal competitors.** A new email tool's references should not be three other email tools — that produces a derivative product with no point of view. Pick references from products that have *the design qualities you want*, not products that *do the same thing*. A fintech dashboard's best references might be Linear (operator UI restraint) + Bloomberg (data density) + Stripe Press (typographic confidence).

**Each reference should bring one distinct quality.** If two references would teach you the same lesson, drop one. Ask of each: "what specific thing does this reference do that I want?" If you can't answer in one sentence, it's the wrong reference.

**Be specific about *what* and *where*.** "Linear" is too broad. "Linear's empty states" is better. "Linear's empty states for issue lists when no filter is applied" is best.

**Reference types worth pulling from.**
- Operator-tool category leaders (Linear, Notion, Height, Plain, Vercel, Raycast)
- Marketing-page lineage (Stripe, Vercel, Apple, Linear, ElevenLabs, Arc, Cursor)
- Editorial/content (NYT, Stripe Press, Quanta, Are.na, MIT Tech Review)
- Mobile native (Things, Reflect, Bear, Notion mobile, Linear mobile, Apple Notes)
- Creative pro tools (Figma, Linear's editor, Procreate, Pixelmator)
- Developer tools (Vercel, Cursor, Raycast, Arc, Warp)

**Avoid.** Generic Dribbble screenshots. Themes/templates from marketplaces (these are the source of "AI slop" patterns the agent is trying to escape). Brand-of-the-month hot products that haven't earned their reputation yet — pick products with sustained taste, not viral ones.

## Deconstructing a reference

For each reference, identify what specifically you're stealing:

- **Typography move.** Family choice, scale ratio, weight hierarchy, letter-spacing on headlines, body-text measure, treatment of numbers/data.
- **Color move.** Foundation neutral (warm/cool/true), use of accent (where it lives, where it doesn't), contrast hierarchy (4-level vs 3-level), surface tinting strategy, how dark mode is handled.
- **Layout move.** Hero composition, section pacing, density of information, use of asymmetry, treatment of cards vs borderless layout, navigation placement.
- **Motion move.** What animates, how snappy, what stays still, how transitions handle continuity.
- **Voice move.** Section headings phrasing, empty states, error states, microcopy, button labels.

You don't need to capture all five for every reference. Capture what's relevant.

## Adapting, not copying

Once you have references and the specific moves you want, **adapt** them to the product's context:

- **Audience translation.** A move that works for Linear's developer audience may need softening for a non-technical SMB user, or sharpening for an enterprise audience.
- **Frequency translation.** A move appropriate for a daily-driver tool may be too dense for a once-a-month surface, or vice versa.
- **Platform translation.** A move that works on web desktop may need rethinking for mobile (touch targets, gesture, viewport).
- **Brand translation.** Strip the reference's literal brand colors and replace with the product's. Don't carry over palette wholesale.

The brief should explicitly state the adaptation: "Linear's command palette pacing, but with this product's warmer neutral foundation and slightly larger touch targets for the mobile-first audience."

## Stating references in the brief

Each reference gets one bullet in the brief's "Reference set" section:

```
- **Linear (issue list & command palette)** — for the calm-dense surface treatment: tight type, restrained palette, navigation that retreats. We adopt the spacing rhythm and the keyboard-first interaction model; we diverge on accent color (Linear's purple is too on-the-nose for our audience).
- **Stripe Press (article pages)** — for typographic confidence at body scale: long measure, generous leading, weight-driven hierarchy. We adopt the type system; we don't go as editorial in chrome.
- **Apple Notes (mobile)** — for the mobile composition discipline: single column, gesture-first, system-level affordances. Reference for the mobile experience only.
```

Each bullet: the reference + what specifically + how we adapt + (optionally) where we diverge. Three bullets max.

## Anti-patterns

- **Listing references without saying *why*.** "Inspired by Linear, Stripe, and Notion" is meaningless. State the specific move.
- **References that contradict each other.** Linear-restraint and Stripe-marketing-expressive at the same time produces incoherence. The references should rhyme.
- **References from the wrong tier.** A consumer mobile app referencing pro creative tools, or a niche operator tool referencing mass-market consumer apps. Match the tier.
- **References the user is unlikely to know.** Obscure picks are great if you can describe what you're taking from them, but the brief should explain enough that the user doesn't need to go look the reference up to evaluate the brief.
- **Too many references.** Four is too many. Six is research. Two well-chosen references with clear adaptation beat five cited generically.
