# Track Defaults

Pick exactly one track based on the surface's primary purpose. The track sets sensible defaults for the four dials, the typical reference set, the copy voice, and the layout philosophy. The product context (audience, frequency, platforms, constraints) shifts the defaults from there — but always anchor to one track. A surface trying to be two tracks at once is a surface failing at both.

If the surface genuinely contains multiple tracks (a marketing site that includes a product demo, a dashboard that includes a sign-up CTA), pick the **dominant** track and treat the secondary content as a guest within that frame.

---

## Product UI

Dashboards, admin panels, settings, data tables, internal tools, operator workflows.

**Dial defaults**: Variance 3 / Density 7 / Motion 3 / Formality 7.

**Character.** Calm dense surfaces. Information dominant, chrome recedes. Strong typographic hierarchy and tight spacing carry the structure; color is reserved for meaning (status, action), not decoration. Cards only when elevation communicates real hierarchy — otherwise plain layout with `border-top` dividers, group headers, or just whitespace.

**Reference territory.** Linear, Notion (workspace surfaces), Stripe Dashboard, Vercel Dashboard, Raycast, Height, Plain.

**Copy voice.** Utility. Section headings name the area or the action ("Selected KPIs" / "Plan status" / "Last sync"). Supporting text explains scope, freshness, or decision value in one sentence. No marketing language, no aspirational hero lines. Sentence case.

**Layout philosophy.** The work surface is dominant. Navigation, page location, and user/workspace context occupy predictable slots that stay quiet. Each bar (location, view controls, page actions) has one job. Use the smallest chrome that still communicates state.

**Default avoid.** Heavy shadows, decorative gradients, hero sections, multiple competing accents, ornamental icons, glowing borders, marketing copy on operational surfaces.

**Common shifts.**
- Consumer-facing product surface (not operator) → Density 5, Formality 5.
- Admin tool with strong brand voice → Variance 5, Formality 5.
- Embedded/dense tool (trading, monitoring) → Density 9, Motion 1.

---

## Marketing

Landing pages, brand sites, promotional surfaces, portfolios, signup-driving pages.

**Dial defaults**: Variance 7 / Density 3 / Motion 7 / Formality 5.

**Character.** Compose first, decorate second. The first viewport should read like a poster: brand or product unmistakable, one dominant visual, one clear takeaway, one primary action. Each section has one job — explain, prove, deepen, or convert. Cardless layouts by default; sections, columns, dividers, and media blocks instead of stacked cards.

**Reference territory.** Linear's homepage, Stripe.com, Vercel.com, Apple product pages, ElevenLabs, Cursor, Raycast site, Arc browser site.

**Copy voice.** Headline carries the meaning. Supporting copy is one short sentence. No filler ("Scroll to explore", "Discover more", bouncing chevrons). No AI clichés ("Elevate", "Seamless", "Unleash", "Revolutionize"). Specific verbs, concrete claims.

**Layout philosophy.** Hero → support → detail → final CTA, in that order, by default. The hero is full-bleed (edge-to-edge) when the surface allows it; only the inner text/action column is constrained. Brand or product name is the loudest element, headline second, body third, CTA fourth. No hero cards, no stat strips, no logo clouds, no floating dashboard mockups in the hero by default.

**Default avoid.** Generic 3-card feature row, centered hero with weak imagery, beautiful image with weak brand presence, carousel without narrative purpose, sections that repeat the same mood, more than two typefaces, more than one accent color.

**Common shifts.**
- Enterprise/financial → Formality 7-8, Motion 4-5.
- Creative agency/portfolio → Variance 9, Motion 9, Formality 4-5.
- Developer tool marketing → Density 5, Formality 7 (denser, more concrete than consumer marketing).

---

## Utility

Focused tools — an editor, a calculator, a viewer, a player, a converter, a single-purpose mobile app.

**Dial defaults**: Variance 2 / Density 5 / Motion 4 / Formality 6.

**Character.** The work surface is everything. Chrome shrinks, retracts, or hides on idle. The tool *is* the interface; navigation/menus/settings are guests that arrive only on demand. Often a single canvas dominates the screen with secondary controls in a thin rail or floating panel.

**Reference territory.** Figma, Linear's editor, iA Writer, Reflect, Things, Bear, Procreate, Pixelmate, PDF readers, video players, OBS-class tools.

**Copy voice.** Spare. Labels short, tooltips short, settings phrased as the action. Empty states explain what the tool does in one line and how to start.

**Layout philosophy.** Choose a primary work surface (canvas, document, viewport) and let it expand to the largest reasonable area. Group secondary controls by function in collapsible/retractable panels. Keyboard shortcuts are first-class — design with them in mind, document them in-product.

**Default avoid.** Persistent navigation that doesn't shrink, decorative chrome around the work area, marketing-style empty states, unnecessary modals, fixed-width content areas that waste viewport.

**Common shifts.**
- Mobile-first single-purpose utility → Density 3, larger touch targets, gesture-first.
- Pro creative tool → Density 7, Formality 7, dark theme primary.
- Consumer utility (calculator, weather, timer) → Formality 3-4, more visual personality.

---

## Content

Editorial, media, reading, browsing, long-form consumption — articles, magazines, video catalogs, documentation.

**Dial defaults**: Variance 4 / Density 4 / Motion 3 / Formality 6.

**Character.** Reading rhythm dominates. Typography carries the design — it does most of the work. Color is restrained to support legibility and hierarchy. Visual interest comes from typographic scale contrast, considered imagery, and whitespace — not from chrome or decoration.

**Reference territory.** NYT, The Verge (article surfaces), Stripe Press, MIT Tech Review, Are.na, Maker's Mark / Aeon / Quanta Magazine, Tailwind CSS docs, Stripe docs, Linear's Method.

**Copy voice.** Whatever the content's voice is — but the chrome around the content is utility (article meta, reading time, share/save, navigation). Don't compete with the content for tone.

**Layout philosophy.** Constrain measure (~65-75 characters for body text). Hierarchy through scale and weight, not color. Strong typographic moments at section breaks (drop caps, pull quotes, full-bleed images, large numbered headings). Sidebars and chrome stay quiet — they orient, they don't participate.

**Default avoid.** Body text wider than ~75ch, multiple competing typefaces in body copy, decorative ornament that fights the reading experience, autoplay video, intrusive subscribe modals during reading, dense product UI patterns inside an article surface.

**Common shifts.**
- Documentation/reference (vs editorial) → Density 6, Formality 7, more sidebar navigation, tighter type.
- Video/media catalog → Variance 6, Density 5, image-forward grid layouts.
- Personal blog/portfolio → Variance 7, Motion 5, Formality 4 — more room for personality.

---

## Choosing the track

If you're unsure, the question is: **what is the user trying to do on this surface?**

- *Get work done with this product, repeatedly* → Product UI.
- *Decide whether to buy / sign up / learn about a thing* → Marketing.
- *Use a focused tool to accomplish a task* → Utility.
- *Read, watch, browse, or otherwise consume content* → Content.

Don't mix. If the surface tries to do two of these at once, design for the dominant one and treat the secondary purpose as a guest. Mixed-purpose surfaces are the most common reason a design feels muddled — every decision pulls in two directions and resolves neither.
