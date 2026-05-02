# AI-Slop Blacklist

Banned patterns drawn from the upstream design-skill corpus. These are the fingerprints of generic LLM-generated UI. Avoiding them is the single biggest lever for making the design feel human-considered.

Pull only the items materially relevant to the current surface and track into the brief's Anti-patterns section — typically 8-15. Don't paste the whole list.

## Typography

- **Inter / Roboto / Arial / system defaults** as primary type. Use distinctive families: Geist, Outfit, Cabinet Grotesk, Satoshi, Suisse Int'l, Söhne, Manrope, IBM Plex, JetBrains Mono, Fraunces, Instrument Serif, Editorial New.
- **Generic browser-default serifs** (Times New Roman, Georgia, Garamond, Palatino). Pick a specific modern serif by name.
- **Serif fonts in operator/dashboard UI** — reads as editorial in a utility context.
- **Title Case On Every Header** — sentence case unless the system explicitly defines an all-caps role.
- **All-caps subheadings everywhere** as a default decoration. Use lowercase italics, sentence case, or small caps where ornamentation is wanted.
- **Only Regular and Bold weights.** Add Medium (500) and SemiBold (600) for subtle hierarchy.
- **Proportional figures in data-heavy contexts.** Use tabular figures or monospace for numerical columns.
- **Oversized H1s with no weight or color discipline.** Hierarchy is weight + color + scale together, not scale alone.
- **Orphan words on the last line.** Use balance/pretty wrapping or rephrase.
- **Body text wider than ~75ch.** Long measure fatigues readers.
- **Straight quotes** (`"` `'`) where typographic quotes belong (`"` `"` `'` `'`).

## Color

- **Purple-on-white "AI gradient."** Indigo-to-violet hero gradients, glow buttons, neon accents. Banned.
- **Pure black `#000000`.** Use off-black, charcoal, zinc-950, or tinted dark.
- **Oversaturated accents above ~80% saturation.**
- **More than one accent color per surface.** Status colors (success/warning/danger) aren't accents; they're semantic.
- **Mixed warm and cool grays in the same product.** Pick one foundation.
- **Pure-black `box-shadow` at low opacity.** Tint shadows to the underlying surface.
- **Sudden palette flips mid-page.** A dark band in a light page (or vice versa) without rationale reads as a paste-up accident.
- **Excessive gradient text on large headlines.** Once clever, now signature slop.
- **Color as the sole carrier of meaning.** Always pair with icon, label, or position.

## Layout

- **Centered hero with faint dark image and centered text.** The universal AI marketing default. Use asymmetric, split-screen, or full-bleed with anchored text column.
- **Three equal cards in a row as the feature section.** Use 2-column zig-zag, asymmetric Bento grid, horizontal scroll, or a list with strong typography.
- **Cards used as the only structural primitive.** Use sections, columns, dividers, lists, and media blocks. Cards only when grouping is meaningful.
- **`100vh` for full-height sections** — breaks on mobile. Use the dynamic viewport equivalent.
- **No max-width on wide content.** Constrain measure even when the surface is wide.
- **Mismatched concentric radii** — `outer = inner + padding` for nested rounded elements.
- **Symmetric vertical padding everywhere.** Adjust optically.
- **Equal-height card forcing.** Allow variable heights or use a layout that handles uneven content gracefully.
- **Always a left sidebar for product UI.** Consider top nav, command palette, retractable rail, or no chrome.
- **Carousels as the answer to "we have multiple things."** Most go un-swiped. Show what matters.

## Components

- **Generic card look (border + shadow + white background) on every container.** Pick one depth strategy and use it consistently.
- **Always one filled + one ghost button as a pair.** Try tertiary text links, single-button surfaces, or dropdown menus.
- **Pill-shaped colored "New" / "Beta" / "AI" badges next to features.** Try square badges, plain text labels, dot indicators, or no label.
- **Accordion FAQs at the bottom of every marketing page.** Try side-by-side lists, search-driven help, embedded inline answers.
- **Pricing table with three columns and a "Most Popular" middle tier** when the product doesn't actually have three tiers.
- **Modals for everything.** Inline editing, slide-over panels, expandable sections, or focused-page navigation are often better.
- **Avatar circles exclusively.** Try squircles or rounded squares when the brand allows.
- **Sun/moon dark-mode toggle in the header.** Try respecting system preference, dropdown with explicit options, or moving the control to settings.

## Iconography

- **Lucide / Feather as the default set.** Use Phosphor, Heroicons, Tabler, Radix Icons, or custom — pick a consistent stroke weight.
- **Cliché metaphors:** rocket for "Launch", shield for "Security", lightning for "Fast", checkmark for "Quality". Use less obvious icons or none.
- **Inconsistent stroke widths across icons in the same UI.**
- **Icons paired with every label.** Many labels don't need icons.
- **Decorative icons in circular colored backgrounds** — the "feature card" stock pattern.
- **Emoji as UI icons.** Never.

## Content & data

- **Generic placeholder names:** "John Doe", "Jane Smith", "Sarah Chan", "Jack Su". Use diverse, realistic-sounding names.
- **Same avatar for every "user".** Use distinct, plausible photos or generators (UI Avatars, Boring Avatars).
- **Fake round numbers:** `99.99%`, `50%`, `$100.00`, `1234567`. Use organic data: `47.2%`, `$99`, `+1 (312) 847-1928`.
- **Placeholder company names:** "Acme Corp", "Nexus", "SmartFlow", "TechStartup". Invent contextual believable brands.
- **Lorem Ipsum.** Write real draft copy.
- **All blog dates the same / all timestamps in the last 5 minutes.** Randomize plausibly.

## Copy

- **AI clichés:** "Elevate", "Seamless", "Unleash", "Next-Gen", "Game-changer", "Revolutionize", "Delve", "Tapestry", "In the world of...", "Leverage", "Synergy", "Empower", "Streamline", "Transform your X". Use plain, specific language.
- **Exclamation marks in success messages.** "Saved" beats "Saved!".
- **"Oops!" / "Whoops!" / "Uh oh!" error messages.** "Couldn't connect — try again" beats "Oops! Something went wrong!".
- **Passive voice.** "We couldn't save your changes" beats "Mistakes were made saving your changes".
- **Marketing language on operational surfaces.** No aspirational hero lines on a settings screen.
- **Filler scroll-prompts:** "Scroll to explore", "Discover more below", bouncing chevrons, animated scroll arrows.
- **Section descriptions that paraphrase the heading.** Every line should add something.

## Imagery

- **Stock "diverse team in office" photography.** Use real team photos, candid shots, or coherent illustration.
- **Abstract 3D objects, blob shapes, gradient meshes as default decoration.** Use real photography, considered illustration, or strong typography over no imagery.
- **Unsplash placeholder URLs** (frequently broken). Use stable services like `picsum.photos` for placeholders.
- **Images with embedded text/logos/UI fighting the surrounding UI.** Choose images with stable areas for overlay.
- **AI-generated images that read as AI-generated** — uncanny lighting, weird hands, melted text.

## Motion

- **Animating layout properties** (width, height, top, left). Use position/scale/opacity.
- **`transition: all` catch-all.** Animates unintended properties.
- **Symmetric enter/exit timing.** Exit should be faster.
- **Permanent decorative animation on every element.** Reserve animation for moments that serve the user.
- **Animation on keyboard-initiated actions.** Power users typing through forms don't want micro-animations.
- **Ignoring `prefers-reduced-motion`.** Honor it always.
- **Generic center-screen entrances for contextual content.** Overlays should emerge from their trigger.
- **Hard cuts between views that share elements.** Animate the shared element from old position to new.

## Design failures rooted in implementation

These often look like design problems but originate in code. Flag them as design constraints in the brief:

- Missing alt text on meaningful imagery.
- Missing loading / empty / error states.
- Missing focus indicators.
- Hardcoded fixed widths that break on different viewports.
- Arbitrary `z-index` values overriding layout decisions.
- Missing 404 / error page design — a dead end is a design failure.
