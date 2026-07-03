---
description: Audit pi SDK upgrade path — breaking changes and improvement opportunities
---

Audit the upgrade path for pi and its related npm packages from the version currently in use to the latest available.

## Workflow

### Phase 1 — Cursory orientation (do this first, sequentially)

1. Read `codemap.md` to understand which parts of the package interact with pi.
2. Find all `@earendil-works/*` packages declared in `package.json` and note their currently installed versions.
3. Note the SDK surface already visible from the codemap — which extension APIs, session types, event names, and tool bridges the package uses.

### Phase 2 — Parallel investigation

Spawn two agents in parallel once Phase 1 is complete:

**Agent A — Version and changelog**

- Look up the latest published versions of all discovered `@earendil-works/*` packages on npm.
- Fetch and read the changelogs for every release between the currently installed version and latest, for each package.
- Produce a structured summary: version-by-version list of breaking changes, deprecations, new APIs, and behaviour changes.

**Agent B — Deep usage analysis**

- Scout all usage sites of the pi SDK across the package: extension registration, session lifecycle calls, event handling, tool bridge calls (`ctx.ui.*`, `ctx.session.*`, etc.), type imports.
- Produce a structured map: which APIs are used, where, and how.

### Phase 3 — Synthesis (after both agents complete)

Cross-reference the two outputs:

1. **Breaking changes that apply here** — for each breaking change in the changelog, identify whether and where it affects this package's usage sites. List concrete files and call sites that need updating.

2. **Improvement opportunities** — for each new API or changed surface in the changelog, assess whether it could simplify or improve how the package currently uses the SDK. Flag any that are worth acting on.

Finish with a prioritised action list: must-fix items before upgrading, and nice-to-have improvements to consider.
