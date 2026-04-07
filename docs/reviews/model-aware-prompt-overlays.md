# Review: Model-Aware Prompt Overlays

**Plan:** `docs/plans/model-aware-prompt-overlays.md`
**Diff range:** `9fcb75a..ebb0a74`
**Date:** 2026-04-07

## Summary

The plan was implemented faithfully across all 6 steps — types, function signatures, module boundaries, test coverage, and extension wiring all match the architecture. One code correctness issue: an unhandled YAML parse error in overlay file loading can silently suppress all overlays when a single file has malformed frontmatter.

## Findings

### 1. Malformed YAML frontmatter crashes overlay loading for entire session

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/model-prompt-overlays/parsing.ts:47-48`
- **Status:** resolved

`parseFrontmatter()` calls `yaml.parse()` internally, which throws `YAMLParseError` on malformed YAML. The call site in `loadOverlayFiles` wraps `readFileSync` in try-catch but does not wrap `parseFrontmatter`. An exception propagates out of `loadOverlayFiles`, up through the root iteration loop in `index.ts`, and out of the `before_agent_start` hook entirely.

Pi's extension runner catches the error (won't crash the session), but the entire hook returns nothing — zero overlays applied, even valid ones from other files or roots already processed and stored in `allMatched`. The blast radius is disproportionate: one bad file in any context root silently drops all overlays. The extension already has a diagnostics pattern for graceful degradation; wrapping the `parseFrontmatter` call in try-catch and pushing a diagnostic would contain the failure to the single bad file.

### 2. Unplanned changes: `agent_complete` → `agent_idle` rename

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/subagents/index.ts`, `extensions/subagents/messages.ts`, `skills/architecting/SKILL.md`, `skills/autoflow/SKILL.md`, `skills/cleanup/SKILL.md`, `skills/code-review/SKILL.md`, `skills/implementing/SKILL.md`, `skills/orchestrating-agents/SKILL.md`
- **Status:** dismissed

The diff range includes a rename of `<agent_complete>` to `<agent_idle>` across the subagents extension (stop sequences, XML serialization, prompt guidelines, identity template) and six skill files, plus revised autoflow retry semantics (continue-before-retrying instead of retry-once-then-escalate). These are separate concurrent changes unrelated to model-prompt-overlays.

## No Issues

Plan adherence: no significant deviations found. All 6 steps implemented as specified — types match the Interfaces section, module boundaries match the Architecture, test coverage covers all scenarios listed in the plan, and the extension hook wiring follows the Runtime Behavior specification. The `literalChars` count for `claude-*` is correctly 7 in the implementation (counting all non-`*` characters including the hyphen), fixing a typo of 6 in the plan's step 3 test examples.
