# Review: Subagent Thinking Tiers

**Plan:** `docs/plans/subagent-thinking-tiers.md`
**Diff range:** `8f97447..1d99237`
**Date:** 2026-07-03

## Summary

The plan was implemented faithfully: `stripThinkingSuffix` and its supporting types are present with the exact signatures specified, `resolveModelRef` and `renderTierTable` are suffix-aware as planned, spawn-path validation and normalization in `index.ts` handle `:level` suffixes correctly, and the system-prompt sentence advertising the shorthand was added. No unplanned changes. Four minor nits (no warnings, no critical issues).

## Findings

### 1. Redundant `modelPart !== undefined` guard in `renderTierTable`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/model-tiers.ts:141-145` (the `renderTierTable` tier loop)
- **Status:** open

`stripThinkingSuffix` always returns `{ model: string, … }` — `model` is never `undefined`. The guard `modelPart !== undefined` in the `isAvailable(modelPart)` branch is dead code. Harmless, but worth removing for clarity.

### 2. `renderTierTable` test doesn't assert the negative direction for availability check

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/model-tiers.test.ts` — `"judges availability on the model part"` test
- **Status:** open

The test asserts `seen.some(r => r === "anthropic/claude-opus-4-8")` (the model part was passed to `isAvailable`) but does not assert that `seen` does *not* contain `"anthropic/claude-opus-4-8:high"` (the full suffixed string was not passed). An implementation that called `isAvailable` with both would still pass. Adding a `!seen.some(r => r === "anthropic/claude-opus-4-8:high")` assertion would close the gap.

### 3. Missing blank line between `stripThinkingSuffix` and `TierName` export

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/model-tiers.ts:43`
- **Status:** open

`stripThinkingSuffix` ends and `export type TierName = …` immediately follows with no blank line, visually running the two declarations together. Every other top-level declaration in the file is separated. No functional impact.

### 4. Model ids coincidentally ending in a valid thinking level are silently parsed as suffixes

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/model-tiers.ts:36`
- **Status:** open

A real model id whose last colon-segment happens to be one of the six valid levels (e.g. a hypothetical OpenRouter id `acme/model:high`) would be misparsed — its last segment stripped as a thinking suffix rather than treated as part of the id. The plan documents this as an accepted tradeoff (non-level suffixes like `:exacto` are left intact; only the exact six-level vocabulary triggers the split), and no known model id collides. Noting for completeness.

## No Issues

Plan adherence: no significant deviations found. Every interface, behavioral contract, and test case in the plan is present and correctly implemented. Test files were not modified after the test-write commit (`435de8d`).

Code correctness: no unhandled errors, race conditions, resource leaks, logic errors, or security issues introduced.
