# DR-061: The Persona Is the Identity, Applied Through a Self-Healing Host Patch

## Status
Accepted

## Context
persona-workspaces makes a workspace's persona file turn the session into that
specialist. The founding axiom, re-affirmed after every alternative was
priced: the persona IS the personality — it displaces pi's default "expert
coding assistant" preamble at the head of the prompt. Stacking the persona
under the default identity is not the feature.

pi 1.3.0 offers no public way to do that cleanly. Its prompt builder couples
the default `tools`, `rules`, and `docs` sections to the default preamble:
`customPrompt` replaces the head but suppresses those sections; custom
sections append after the working-directory line; and a section named
`preamble` throws. The preamble is untagged by design — the anchor the tagged
section machinery measures from — and single-writer by policy (`customPrompt`
is its only input).

Five designs were built or priced against the full requirement set (identity
at the head, small transcript deltas, clean composition, truthful record, no
silent failure):

- **`customPrompt` binding** (the original): wiped pi's tool declarations,
  rules, and docs from every persona session.
- **Renderer mirror + inline blocks**: preserved layout, but re-recorded the
  whole merged preamble on every body edit and maintained ~60 lines of
  pi-rendering mirror that silently drifted.
- **End-position sections**: native per-section deltas, persona not at the
  head. Layout rejected.
- **Projection (forced `systemPrompt` head-swap, no record)**: nothing
  appended and the mirror shrank to one sentence, but the forced-render
  machinery returned, load order mattered again, and a changed pi sentence
  silently dropped the persona from the request.
- **Stacking as the primary**: contradicts the axiom; kept only as a
  bootstrap.

In-process patching is not available: the builder sits behind a sealed ESM
binding, and the one live seam (wrapping the private
`AgentSession.prototype._preparePromptAndToolLoadout`) couples to an
underscore API that fails silently on rename. pi's package manager runs no
lifecycle scripts, so install-time patching has no hook, and it would not
fire on pimote releases (which replace the runtime without reinstalling
packages).

## Decision
Patch the host runtime, self-healing, at extension activation.

`host-patch.ts` applies three exact-string touches to the host's
`dist/core/system-prompt.js`: drop the `preamble` rejection from
section-name validation; let `sections.preamble` override the default
sentence when `customPrompt` is unset; keep the merge loop from
re-assigning `preamble`, so an explicit `--system-prompt` always outranks
it. The write is atomic (temp file + rename), idempotent, and all-or-nothing
with per-snippet verification — an incompatible pi is reported, never
half-patched.

Tiering, decided once per host runtime directory at activation:

- **Patched**: the persona body binds as `sections.preamble` — pi's first
  slot, pi's own sections untouched below it, body edits recorded as small
  preamble-only deltas, the transcript record equal to the request.
- **Unpatched or incompatible**: the persona stacks as a plain `<persona>`
  custom section on top of pi's preamble until the patch activates. The
  running process keeps its in-memory module, so the tier activates from the
  next session start; the user is told once (restart hint, or the
  incompatibility reason).

All package prompt contributions compose through structured options —
Subagents contributes a `subagents` section, Model Prompt Overlays a
`model-overlays` section, nothing returns a forced `systemPrompt` — so
extension load order (directory scan, unpinned) carries no correctness
weight.

Rejected along the way: a manifest load-order pin (superseded — with no
forced renders, ordering is correctness-neutral and the pin was permanent
maintenance); upstream PR as the only path (the right long-term change, but
nothing ships locally until npm and pimote catch up — the same three-touch
diff can be upstreamed from `host-patch.ts` when wanted); a `NODE_OPTIONS`
module loader (covers even the first session, at the cost of mutating the
launch environment for every node process).

## Consequences
- The transform is snippet-coupled to pi 1.3.0's dist output. A reshaped
  builder reports "incompatible" and the persona runs stacked with a warning
  — degraded granularity, never a broken file or a silent no-op.
  Re-alignment is a string update in `host-patch.ts`. Watch-item: if
  upstream ever accepts `sections.preamble` natively, the detection must be
  re-aligned (or the patch dropped for a version gate) — the marker check
  would otherwise misreport a capable runtime as incompatible.
- One fallback-tier session per pi/pimote update: the session that applies
  the patch runs in-memory unpatched code. Every later session is
  override-tier. The stacked tier keeps the persona working in that window.
- The patch writes into a release tree we do not own. Confined to one dist
  file, reversible, exact-string; pimote releases wipe it and the next load
  re-applies. The pimote bundle and the CLI install heal independently —
  each runtime is patched by the processes that load the extension on it.
- Cache behavior is axiom-forced, not design-chosen: the persona lives at
  the head, so a mid-session body edit invalidates the provider prefix
  cache in every compliant design. Body edits are rare human actions, and
  between-session edits face a cold cache regardless.
- Session transcripts stay truthful in both tiers: the record carries the
  persona (override) or the persona section (stacked), and body-edit deltas
  stay small.
