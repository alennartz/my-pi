# Review: Model-Aware Prompt Overlays

**Plan:** `docs/plans/model-aware-prompt-overlays.md`
**Diff range:** `9fcb75a606d9e793a26bed8a9dc73a06e4339535..331e38f6b2dcdff9898adb0668a7ab8f9759a1be`
**Date:** 2026-04-07

## Summary

The model-aware prompt overlays extension was implemented faithfully across all six plan steps — every planned file exists, all 37 tests pass, and the core logic (discovery, parsing, matching, rendering, diagnostics, hook wiring) matches the architecture. Two significant issues stand out: a local frontmatter parser was created instead of using pi's `parseFrontmatter` export as the plan requires, and the diff includes unplanned behavioral changes to the subagents extension (`agent_complete` → `agent_idle` rename) that were applied incompletely — 5 skill files still reference the old tag name.

## Findings

### 1. Incomplete agent_complete → agent_idle rename in skill files

- **Category:** code correctness
- **Severity:** critical
- **Location:** `skills/orchestrating-agents/SKILL.md:12,63,67,82,199`, `skills/implementing/SKILL.md:68,70,89`, `skills/code-review/SKILL.md:32`, `skills/cleanup/SKILL.md:50`, `skills/architecting/SKILL.md:76`
- **Status:** resolved

The subagent changes in this diff renamed the XML notification tag from `<agent_complete>` to `<agent_idle>` in `messages.ts` and updated references in `index.ts` (stop sequences, prompt guidelines, completion message text). However, 5 skill files across 12+ occurrences still reference `<agent_complete>`. These skills are LLM-facing instructions — agents following them will be told to wait for `<agent_complete>` notifications that now arrive as `<agent_idle>`. While LLMs may adapt in context, the mismatch degrades instruction quality and could cause agents to miss or misinterpret notifications. This is an incomplete rename.

### 2. Local frontmatter parser replaces pi's parseFrontmatter

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `extensions/model-prompt-overlays/frontmatter.ts:1-92`, `extensions/model-prompt-overlays/parsing.ts:3`
- **Status:** resolved

The plan explicitly specifies using `parseFrontmatter` from `@mariozechner/pi-coding-agent` in three places: Step 2 ("parse frontmatter using `parseFrontmatter` from `@mariozechner/pi-coding-agent`"), Step 6 imports list, and the Architecture dependencies section. Instead, a local `frontmatter.ts` was created with a hand-rolled YAML parser.

This introduces two risks: (1) **Behavioral divergence** — pi's `parseFrontmatter` trims the body (`.trim()`), while the local version does not. The rendering step only calls `trimEnd()`, so overlays may have a leading blank line in the rendered block that wouldn't exist with pi's parser. (2) **Robustness** — pi's parser uses the `yaml` npm package for full YAML parsing; the local parser handles only a limited subset (scalars, inline/block arrays). Edge cases in YAML syntax would behave differently.

The `index.ts` imports list also deviates from the plan — only `getAgentDir` is imported from pi, where the plan specifies both `getAgentDir` and `parseFrontmatter`.

### 3. Unplanned behavioral changes to subagents and autoflow

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `extensions/subagents/index.ts` (4 changes), `extensions/subagents/messages.ts` (3 changes), `skills/autoflow/SKILL.md` (5 hunks)
- **Status:** open

The plan states "No existing codemap module changes its runtime responsibilities" and that Subagents "remain behaviorally unchanged." The diff includes:

- `agent_complete` XML tag renamed to `agent_idle` in serialization and stop sequences (subagents extension)
- Completion message text changed from "have completed" to "are now idle" with different guidance
- Autoflow skill: transition validation text updated, retry semantics changed from "retry with one fresh subagent" to "send a message to continue", escalation criteria revised

These are meaningful behavioral and instructional changes to existing modules that fall outside the plan's stated scope. They appear to be a separate concern (subagent idle-state semantics) that was implemented alongside this feature.

### 4. Frontmatter parser rejects valid unindented YAML block arrays

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/model-prompt-overlays/frontmatter.ts:60`
- **Status:** resolved

The block array detector requires leading whitespace before the `-` marker: `/^\s+-\s/`. Standard YAML allows block sequence entries without indentation:

```yaml
models:
- claude-*
- gpt-*
```

This is valid YAML, but the parser won't recognize it. The `models` key ends up unset in frontmatter (the `value === ""` branch falls through without setting anything when no indented items are found), triggering a "Missing 'models'" diagnostic. Users familiar with YAML conventions might write this form and receive a confusing error. The regex should use `/^\s*-\s/` (zero or more whitespace) to accept both forms. This finding compounds with Finding #2 — pi's actual `parseFrontmatter` handles this correctly via the `yaml` package.

### 5. Plan's literalChars example corrected

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `extensions/model-prompt-overlays/matching.test.ts:34`
- **Status:** dismissed

Plan Step 3 says `claude-*` → `literalChars=6`. The implementation and tests correctly use `literalChars=7` (`claude-` has 7 characters). The plan had an arithmetic error; the implementation reasonably deviates.

### 6. discoverContextRoots doesn't normalize agentDir path

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/model-prompt-overlays/discovery.ts:25-29`
- **Status:** resolved

The ancestor walk uses `resolve(cwd)` to get a canonical absolute path, but `agentDir` is used as-is. Deduplication relies on exact string comparison of file paths in `seenPaths`. If `agentDir` contained `..` segments or wasn't fully resolved, the same physical directory could appear as both a global root and an ancestor root because the path strings wouldn't match. In practice, `getAgentDir()` returns a clean absolute path, so this is unlikely to manifest. A defensive `resolve(agentDir)` at the top would eliminate the risk.

## No Issues

Plan adherence (excluding findings above): all six plan steps were implemented with correct structure, types, and test coverage. All planned files exist with expected names and exports. The `sortMatchedOverlays` function was correctly extracted to `matching.ts` per Step 6. The `IndexedMatchedOverlay` type correctly extends `MatchedOverlay & { rootIndex: number }`. Test coverage addresses all cases specified in the plan.
