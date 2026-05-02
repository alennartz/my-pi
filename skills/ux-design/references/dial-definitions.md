# Dial Definitions

Four internal dials drive every design decision. They are platform-agnostic mental tunings — not user-facing controls. The brief states which level you picked and a one-line rationale; it does not show the user a slider.

Pick a level for each dial after picking the track and gathering product context. Track defaults give you a starting point; the specific product (audience, frequency of use, emotional goal) shifts the picks from there.

---

## Variance — structural predictability

How much the layout obeys a regular grid versus breaks from it.

| Level | Character | When to pick |
|------|-----------|--------------|
| 1-3 — Symmetric | Strict columnar grids, equal padding, centered or left-anchored, predictable component order. Calm and efficient. | Operator tools used all day, data-heavy product UI, dense workflows where surprise is friction. Form-heavy surfaces. |
| 4-6 — Offset | Mostly grid-aligned but with intentional offsets — varying card sizes, asymmetric pairs, occasional bleed. Reads as designed without losing structure. | Product UI that wants more personality (consumer SaaS, dashboards with a brand voice), most marketing pages. Default for most surfaces. |
| 7-10 — Asymmetric | Broken grid, masonry, fractional grid units (2fr 1fr), large empty zones, intentional overlap, off-canvas bleed. Reads as editorial. | Marketing landing pages with a strong narrative, brand sites, portfolios, editorial/content. Use sparingly on operator-facing surfaces. |

**Mobile rule.** Variance >5 must collapse to single-column on small viewports. Asymmetric tablet/desktop layouts that don't have a clean mobile fallback are broken, not bold.

---

## Density — information per pixel

How packed the surface is.

| Level | Character | When to pick |
|------|-----------|--------------|
| 1-3 — Airy | Generous whitespace, large section gaps, oversized type, one idea per screen. Reads as expensive, calm, premium. | Marketing heroes, brand sites, content/editorial reading experiences, consumer onboarding. Anywhere the user is in discovery mode. |
| 4-6 — Standard | Normal app pacing — comfortable padding, clear hierarchy without crowding. The everyday default for most product surfaces. | Most product UI screens, settings, list views, mid-density dashboards, consumer mobile apps. |
| 7-10 — Packed | Tight padding, small gaps, monospace numbers for data, often borderless (1px lines instead of card boxes), every pixel earns its keep. Reads as professional/operational. | Operator tools, trading/monitoring/analytics dashboards, data tables, dev tools, anything used many hours per day. |

**Calibration rule.** Density should match how often the user comes back. High frequency → high density. Low frequency → low density. A first-time-visitor marketing page at density 8 looks oppressive; a daily-driver dashboard at density 3 wastes the operator's time.

---

## Motion — animation budget

How much the interface moves on its own and in response to interaction.

| Level | Character | When to pick |
|------|-----------|--------------|
| 1-3 — Static | No autonomous motion. Hover/focus state changes only. Transitions ≤150ms, opacity/color only. | Accessibility-sensitive surfaces, dense operator tools (motion is friction here), embedded/low-power devices, terminal-like UIs. |
| 4-6 — Functional | Motion as feedback and orientation only. Subtle entrances, smooth state transitions (200-300ms), reduced-motion respected. No decorative animation. | Most product UI. Default. Animation serves the user's understanding of state changes — nothing more. |
| 7-10 — Expressive | Cinematic moments, scroll-driven sequences, perpetual micro-loops on accent components, playful entrances, choreographed staggers. Reads as branded and alive. | Marketing pages, brand-forward consumer products, hero moments inside a product (first-run, success states). Use surgically — not everywhere. |

**Universal rules regardless of level.**
- Motion should serve continuity, feedback, orientation, or deliberate delight — never decoration alone.
- Exit animations are faster than entrance animations.
- Keyboard-initiated actions (shortcuts, tab navigation) do not animate.
- Reduced-motion preference must be honored at any level.
- Animate position, scale, and opacity — not size or layout properties. The platform's compositor handles those cheaper.

---

## Formality — emotional register

How the design *feels*, independent of how busy or motion-heavy it is.

| Level | Character | When to pick |
|------|-----------|--------------|
| 1-3 — Playful | Warm palettes, rounded everything, looser type, hand-drawn or illustrated accents, exclamation-light but conversational copy. | Consumer products with broad audience, education/learning apps, kids/family, social products. |
| 4-6 — Approachable | Friendly but professional. Modest rounding, warm neutrals possible, conversational utility copy, light brand personality without informality. | Most consumer SaaS, prosumer tools, modern B2B products. The default for things that want to feel human without being toy-like. |
| 7-8 — Refined | Restrained, considered, quietly confident. Tight type, neutral palettes with one sharp accent, precise spacing, utility copy. Linear / Stripe / Vercel territory. | Pro tools, B2B platforms targeting taste-aware users, financial products that want trust without austerity. |
| 9-10 — Luxury / clinical | Severe restraint, near-monochrome or single dominant hue, editorial type at scale, generous whitespace, almost no decoration. Reads as expensive or institutional. | Luxury brand, finance/legal/medical at the high end, editorial/cultural institutions. Easy to overshoot into cold/sterile if the product doesn't earn it. |

**Watch for mismatch.** Formality below the audience's expectation reads as unprofessional; above it reads as pretentious. A community garden app at Formality 9 is wrong; a private banking app at Formality 2 is wrong. Calibrate to who the user is, not what *you* find aesthetically interesting.

---

## How dials interact

The four dials are not independent — combinations have character:

- **Low Variance + High Density + Low Motion + High Formality** → operator dashboard (Linear, Bloomberg-lite, monitoring tools).
- **High Variance + Low Density + High Motion + Mid Formality** → marketing landing (most expressive brand sites).
- **Low Variance + Mid Density + Low Motion + Low Formality** → consumer mobile app (Calm-like, Headspace-like, friendly utility).
- **Mid Variance + Low Density + Mid Motion + High Formality** → premium content/editorial (NYT-tier reading, brand magazines).
- **High Variance + High Density + High Motion + Low Formality** → almost always wrong (chaotic, fatiguing). If you find yourself there, reconsider the track.

State the four picks as a tuple early in the brief (e.g., `Variance 5 / Density 7 / Motion 3 / Formality 7`) and reference them when justifying downstream decisions about palette, typography, spacing, and components.
