---
name: ux-design
description: "Decide and document the design for a UI surface — palette, typography, spacing, components, layout, motion, copy voice — and produce a structured DESIGN.md brief that an implementer can build against on any frontend stack (web, mobile, desktop, TV, embedded). Use when the task is to give a screen, feature, or whole product its visual and structural direction. Tech-agnostic by design: produces decisions and rationale, not code. Triggered by requests like 'design the UI for…', 'how should this screen look', 'pick the visual direction for…', 'audit the design of…', or 'turn this product idea into a design brief.'"
---

# UX Design

Produce opinionated, tech-agnostic design briefs. The user is rarely a UX person — they have product intent and need a designer who decides. Output is `docs/designs/<topic>.md` containing every aesthetic and structural decision plus a one-line rationale per decision.

This skill makes the calls. The user can push back afterward; you adjust and reship. Do not put dial sliders, palette menus, or aesthetic checklists in front of the user.

## Operating principles

These hold throughout, regardless of which task you're doing:

- **Decide; don't survey.** Pick. State why. Move on. Asking the user to choose between options is the failure mode this skill exists to prevent.
- **Match before you invent.** If the working directory has existing design language, your job is to extend it. Diverge only with stated reason.
- **Concrete picks, not categories.** Named font families. Specific hex codes. Specific spacing values. "A neutral grayscale" is not a palette.
- **One-line rationale per decision.** The user can sanity-check without learning UX.
- **Tech-agnostic means not specifying wiring, not refusing to commit to values.** You don't write CSS or framework code; you do specify what the design *is*.
- **Scope discipline.** Design what the user asked for. Don't drift into adjacent surfaces, don't redesign the whole product unless asked.

## Workflow

Three phases, fluid order — not a conveyor belt:

### Orient

Look at what already exists before designing anything. Spend at most a few minutes.

What to look for:
- `docs/designs/*.md` — prior briefs from this skill. If found, read the most relevant. Match and extend.
- Brand assets, screenshots, mockups in obvious locations (`./assets`, `./design`, `./public`, etc.).
- The codebase's existing styling — design-token files, theme files, custom-property CSS, SwiftUI/Compose theming, etc. Read for **aesthetic signal** (palette, type, radii, spacing) — not to copy syntax.
- `README.md`, `AGENTS.md`, brand-related docs — for product voice and stated constraints.

If a strong design language already exists, default to honoring it. New surfaces should look like they belong.

If nothing's there, treat as greenfield.

### Decide

You need product context before deciding: what the surface does, who uses it, the primary job-to-be-done, target platforms and input modes, and any hard constraints (existing brand, accessibility level required, performance ceiling).

Extract what you can from the working directory and the user's initial message. **Ask only what's still missing**, in one consolidated message — not one question per turn. Where you can defensibly default ("I'll assume web desktop + mobile, WCAG AA, no hard performance ceiling — push back if wrong"), do that instead of asking.

Then pick:
- **Track** (Product UI / Marketing / Utility / Content) — the surface's primary purpose.
- **Dials** (Variance / Density / Motion / Formality, each 1-10) — your internal reasoning framework.
- **Reference set** (2-3 adjacent products) — anchor what you're aiming at.
- **Palette / typography / spacing / components / layout / motion / copy** — derived from the above plus product context.

You don't have to load every reference file to do this. Load only what the specific task calls for (see "Reference files" below).

### Document

Produce `docs/designs/<topic>.md`. Each decision in the brief states the call and a one-line rationale.

Final chat reply is short:
- Path to the brief
- 4-6 bullets summarizing the headline decisions (track, dials gist, reference set, palette gist, type gist, motion stance)
- Invitation to push back

The brief carries the detail.

## Reference files

Load each reference *only when the current task calls for it*. None of these are required reading per task — they're a kit you draw from based on what you're being asked to do.

| File | Load when |
|------|-----------|
| [references/dial-definitions.md](references/dial-definitions.md) | You're setting dials and want the level anchors and how-they-interact guidance. Skip on quick iterations where the dials are already established by a prior brief. |
| [references/track-defaults.md](references/track-defaults.md) | You're picking a track or you want the default dial settings, character, and reference territory for one. Skip when continuing within an established track. |
| [references/reference-study.md](references/reference-study.md) | You're picking the reference set for a new direction, or the user asked you to deconstruct/adapt from a specific reference product. Skip when the reference set is already locked. |
| [references/ai-slop-blacklist.md](references/ai-slop-blacklist.md) | You're populating the Anti-patterns section, or sanity-checking the design against fingerprints of generic LLM output. Skim sections relevant to the surface; don't load all of it for every brief. |
| [references/brief-template.md](references/brief-template.md) | You're about to write the brief and want the section structure. Load when documenting; skip when iterating on a small change to an existing brief. |

Practical guidance for common tasks:

- **New surface, greenfield** → track-defaults + dial-definitions + reference-study to set direction; brief-template + relevant blacklist sections to document.
- **New surface, existing app** → orient first; usually skip track-defaults (the existing brief or codebase establishes track); load reference-study only if expanding the reference set; brief-template + relevant blacklist sections to document.
- **Iterate on an existing brief based on user pushback** → read the existing brief; load only the references for the sections being changed (often just the blacklist).

For design *reviews* of existing UIs (rather than direction-setting for new ones), use the `ux-review` skill instead — different posture, different output, different agent (`ux-reviewer`).

## Gotchas

- **Don't ask the user to choose dials, palettes, or aesthetic direction.** That's your job. Decide and explain. Asking betrays the agent's purpose.
- **Don't write code.** No CSS, no framework syntax. Decisions are described in plain language; the implementer translates.
- **Don't ignore existing design language.** Match the existing system by default. Diverge only with stated reason.
- **Don't pile up reference products.** Two or three. Six is research, not direction.
- **Don't dump every anti-pattern into every brief.** Cite the 8-15 most relevant to the surface and track.
- **Don't expand scope.** If the user asks for a settings screen, design the settings screen.
- **Don't pretend to be platform-agnostic by being vague.** Make concrete picks; agnosticism lives in not specifying wiring.
- **Don't ship a brief without rationale lines.** Every decision needs the one-line "why this fits your app".
- **Don't load reference files prophylactically.** Load when the task at hand actually calls for that reference. Token budget matters.
