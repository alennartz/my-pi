# Review: Model Tiers

**Plan:** `docs/plans/model-tiers.md`
**Diff range:** `6f41dea0af065072727dba5793bdc9514286d220..2d55d1b` (HEAD)
**Date:** 2026-07-02

## Summary

The plan was implemented faithfully — all ten steps trace cleanly to the diff, test files are byte-identical to the pre-implementation commit, and the full suite passes (236/236). One warning: the project config directory name is derived from `getAgentDir()` instead of using a stable constant, which breaks silently under the `PI_CODING_AGENT_DIR` env override. Two low-risk nits round out the findings.

## Findings

### 1. Project config dir derived from `getAgentDir()` breaks under `PI_CODING_AGENT_DIR` override

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/index.ts:256-270`
- **Status:** resolved

Plan Step 5 called for importing `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent`, but that constant isn't re-exported from the package index — so the implementation derives it via `path.basename(path.dirname(getAgentDir()))`. The adaptation was necessary, but the chosen derivation is fragile: `getAgentDir()` honors the `PI_CODING_AGENT_DIR` env var and returns that path verbatim, with no guaranteed `<dir>/.pi/agent` shape. With the override set (e.g. `/tmp/pi-test-home`), the derivation yields the wrong segment, so project config is looked up at `<cwd>/<wrong-name>/model-tiers.json` and silently never loads (the loader swallows missing files by design). Sibling code in the same extension already hardcodes `".pi"` (`extensions/subagents/agents.ts:186`), which would be strictly more predictable. As written, global and project config resolution disagree under env override and the failure is invisible.

### 2. Dedup set outlives the session — "per-session dedup" comment is inaccurate

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/index.ts:271-281`
- **Status:** resolved

The `notifiedTierIssues` `Set` lives in the extension closure, created once per extension load — not per session. After `/new` in the same pi process, a previously-shown warning (e.g. "tier configured as unavailable model") is silently suppressed for the new session. This matches the precedented `model-prompt-overlays` diagnostics pattern, but the comment "Per-session dedup" over-promises, and a user who fixes-then-unfixes config can miss a genuinely relevant warning.

### 3. Placeholder string `"session default"` rendered as if it were a model id

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/index.ts:487`, `extensions/subagents/model-tiers.ts:100-110`
- **Status:** open

When `ctx.model` is undefined at `before_agent_start`, the tier table renders `` `session default` (default) `` — a non-id in code formatting, contradicting the module doc's claim that transcripts always record which model a tier-named spawn actually used. An LLM reading the table could echo `session default` back as a model ref. Cosmetic in practice since `ctx.model` is nearly always set.

## No Issues

**Plan adherence: no significant deviations found.** All steps (1–10) match the plan's documented contracts, including warning semantics, `(default)` marker, table format, tier-name validation skip, `resolveModelRef` covering both tool overrides and agent-definition pins, `## Available Models` block replacement, and the `list_models` tool gating and output format. Every hunk in the implementation range maps to a plan step. Test immutability verified: `extensions/subagents/model-tiers.test.ts` is unchanged between `93586a1` (pre-implementation) and HEAD; the only removals in the interface file `model-tiers.ts` are the four stub bodies. Full suite passes: 236/236.

**Code correctness (beyond the findings above):** `isTierName`/`loadTierConfig`/`resolveModelRef`/`renderTierTable` are pure; error-swallowing file reads match their documented contract; untrusted-project gating is in the correct direction; validation and resolution use the same matching predicate (no pass-validation-fail-resolution gap); no closures bind reassignable outer slots; no dead code introduced.
