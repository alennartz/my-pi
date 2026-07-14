---
name: ux-review
description: "Audit an existing UI surface for design quality — visual hierarchy, consistency, ergonomics, anti-patterns, design system adherence — producing priority-grouped findings with concrete fixes and a ship-readiness verdict. Use when the user asks to audit or review a UI's design, or whether it's visually ready to ship. Assesses what the design *is*, not how it's implemented. An optional focus area scopes the audit; without one, audit the whole UI in scope."
---

# UX Review

Audit an existing UI for design quality. The output is `docs/designs/<topic>-audit.md` containing priority-grouped findings with concrete fixes and a top-level ship-readiness verdict.

This is **design-quality** review, not **code-quality** review. You assess visual hierarchy, consistency, ergonomics, design-system adherence, and AI-slop fingerprints. You do **not** assess implementation correctness, framework idioms, or code-level accessibility violations (axe-core, jsx-a11y, Lighthouse all do that better). If the user wants code-quality auditing, defer.

## Inputs you need

To audit, you need *something to look at*:

- Screenshots / mockups in the working directory
- A live URL the user has running locally or publicly
- Component files / styling files in the codebase (read for visual signal — palette, type, spacing — not for implementation correctness)

If none of these are available, ask the user to point you at something. Do not audit from a verbal description alone — too much guesswork.

## References

Load these only when actively useful. The blacklist, dials, and tracks are shared with the `ux-design` skill (symlinked into this skill's `references/` directory) so the vocabulary stays unified across creation and review.

- [references/ai-slop-blacklist.md](references/ai-slop-blacklist.md) — banned patterns to check the surface against. The most-loaded reference during audits.
- [references/dial-definitions.md](references/dial-definitions.md) — when assessing whether a surface's density / motion / formality match its track and audience.
- [references/track-defaults.md](references/track-defaults.md) — when the surface's track is unclear and you need to figure out what it's aiming at.

## Workflow

```text
Audit progress:
- [ ] Step 1: Establish what's being audited (which surfaces, any focus area)
- [ ] Step 2: Figure out the surface's apparent intent — what it's aiming at
- [ ] Step 3: Run priority categories against the surface(s)
- [ ] Step 4: Group findings by priority, then by surface
- [ ] Step 5: Write docs/designs/<topic>-audit.md with findings + concrete fixes
- [ ] Step 6: Summarize verdict in chat
```

### Step 1 — Scope

Take scope from how the user framed it. "Audit this app" or "review the UI" means everything reachable — don't narrow it. "Audit the dashboard" means the dashboard and its sub-surfaces. A focus area ("check spacing consistency," "audit the nav") narrows what you're looking *for*, not what you're looking *at*, unless the user pairs it with a surface.

Only ask for clarification when scope is genuinely ambiguous — not as a reflex. Don't expand mid-audit; if you notice issues outside scope, note them in passing and offer a separate audit.

### Step 2 — Read the surface's intent

Figure out what the surface is aiming at: what track it sits in, what dial settings it seems to want, what audience it serves. Assess against that intent, not against your taste in isolation. Existing styling files, brand assets, and any product context in `README.md` / `AGENTS.md` are fair game for signal.

### Step 3 — Priority categories

Run findings through these categories in priority order. Don't pile findings into "miscellaneous"; place each one.

| Priority | Category | What it covers |
|----------|----------|----------------|
| **CRITICAL** | Accessibility & ergonomics | Hit targets too small, focus indicators missing, contrast failing AA, content unreadable on some viewport, keyboard navigation broken. Blocks users. |
| **CRITICAL** | Consistency failures | Same element rendered differently in different places (different padding, different colors, different state behavior). Erodes trust in the UI. |
| **HIGH** | Hierarchy & scanability | Multiple elements competing for attention, unclear primary action, headings that look like body text or vice versa, tables that don't read as tables. |
| **HIGH** | Anti-patterns from the blacklist | AI-slop fingerprints — Inter everywhere, purple gradients, 3-card feature rows, generic empty states, "Lorem Ipsum" or "John Doe" placeholders shipped to prod. |
| **HIGH** | Missing states | No empty / loading / error states, missing hover/focus, no disabled treatment, no selected state on selectable items. The surface looks finished but breaks at edges. |
| **MEDIUM** | Polish | Optical alignment misses, mismatched concentric radii, inconsistent shadow direction, slightly-off type scale, decorative motion that doesn't serve the user. |
| **MEDIUM** | Voice & content | AI copywriting clichés, marketing language on product surfaces, exclamation marks on success states, passive-voice errors, generic empty-state copy. |
| **LOW** | Refinement opportunities | Things that aren't wrong but would be better with adjustment. Save these for the bottom; don't let them dilute the priority of real issues. |

### Step 4 — Format findings

Group findings first by priority, then by surface within each priority. Each finding has three parts:

- **What's wrong** — the specific problem, with location ("Dashboard top bar, left side" / "Settings page, billing card" / `Component.tsx:42` if pointing at code).
- **Why it matters** — the failure mode this causes for the user or the design.
- **Concrete fix** — what to do instead, in plain language. Specific enough to act on, not so specific that it becomes implementation prescription.

Example:

```markdown
## CRITICAL

### Settings → Billing card

- **Inconsistent button hierarchy.** The "Update payment method" button and "Cancel subscription" button render at the same visual weight (both filled primary). Cancel subscription is a destructive action and should be visually distinct (ghost or destructive variant); Update payment method is the primary action and should dominate.
  - **Fix:** Make Update payment method the primary filled button. Demote Cancel subscription to a tertiary text link, or render it as a destructive-variant button if the destructive treatment exists in the system. They should not look like equivalent options.

- **Card lacks empty state.** When the user has no saved payment methods, the card shows blank space. There is no path forward.
  - **Fix:** Design an empty state with a one-line explanation ("No payment methods on file") and a primary action ("Add a card").
```

### Step 5 — Write the audit file

Path: `docs/designs/<topic>-audit.md` where `<topic>` describes the audit scope (e.g. `dashboard-audit.md`, `app-audit.md`, `nav-audit.md`).

Top of the file:
- One-sentence summary of what was audited
- Verdict (see below)
- Counts by priority

Body:
- Findings grouped by priority, then surface

Bottom:
- Short list of *clean surfaces* — surfaces examined that had no findings worth noting. Important to flag what was actually examined, not just what failed.

### Step 6 — Verdict

Render at the top of the file and in the chat summary:

- **❌ NOT READY** — One or more CRITICAL findings. Should not be considered design-complete until addressed.
- **⚠️ READY WITH FOLLOW-UP** — No CRITICAL, but more than 3 HIGH-priority issues. Can ship if there's reason to, but issues should be tracked.
- **✅ READY** — No CRITICAL, ≤3 HIGH. Polish-tier issues only. Ship and address in a follow-up pass.

The verdict's purpose is to give the user a single-glance answer to "is this in good shape?". Don't inflate (every audit ≠ "not ready") and don't deflate ("ready" with three blocking accessibility issues). Calibrate honestly.

## Gotchas

- **Don't audit code quality.** Wrong indent, missing prop types, hooks misused — not your job. If you find yourself flagging code-level issues, stop and refer the user to a code-review skill.
- **Don't audit implementation choices that aren't visible.** "This component should use CSS Grid instead of Flexbox" is a code suggestion, not a design finding. The design finding is "this column doesn't align with the column above it" — the implementer figures out grid or flex.
- **Don't pile up LOW findings.** Six "could be slightly better" suggestions drown out one CRITICAL issue. Be ruthless about what makes the cut.
- **Don't audit beyond scope.** If the user asked about the dashboard, don't drift into the marketing site. Mention adjacent issues in passing if you noticed; offer a separate audit.
- **Don't audit against your taste alone.** If the surface makes a deliberate choice that diverges from the blacklist (e.g., using Inter intentionally for a specific reason in an existing system), don't flag the choice. Note as an observation if you want; user's prior decisions deserve respect.
- **Don't write fixes as code snippets.** Plain-language description is the deliverable. The implementer translates.
- **Don't claim to have audited what you didn't see.** If you haven't viewed a screen, don't list it as a clean surface. Be explicit about what was examined.
