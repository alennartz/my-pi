# Review: Subagent State UI Revamp

**Plan:** `docs/plans/subagent-state-ui.md`
**Diff range:** `d8472f01..ac45128`
**Date:** 2026-03-15

## Summary

The plan was faithfully implemented across all six steps. The three-file change set matches the architecture closely — `AgentStatus` extensions, event tracking in `group.ts`, factory-based `SubagentDashboard` component in `widget.ts`, and the wiring in `index.ts` all follow the plan's spec with only minor, reasonable adaptations. Two correctness issues found: a `waitingFor` tracking bug with duplicate targets, and a potential ANSI color nesting problem in the footer renderer.

## Findings

### 1. `waitingFor` filter removes all occurrences of a target

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/group.ts:390`
- **Status:** open

When `clearAgentWaiting` resolves a correlation, it filters `waitingFor` with `entry.status.waitingFor.filter((t) => t !== target)`, which removes *every* occurrence of that target ID. If an agent has two concurrent blocking sends to the same target (possible via parallel tool calls in a single turn), resolving the first response removes *both* entries from `waitingFor`. The agent would stop showing as waiting-for that target in the UI even though a second blocking send is still pending.

The underlying `pendingCorrelations` tracking is correct (exact correlation ID match), so this is a display-only bug — state transitions and idle detection are unaffected. A fix would be to splice only the first matching index, or to store correlation IDs in `waitingFor` instead of target names.

### 2. Footer ANSI color nesting may break `dim` coloring

- **Category:** code correctness
- **Severity:** warning
- **Location:** `extensions/subagents/widget.ts:286-291`
- **Status:** open

The footer builds `inner` by joining plain-text parts with `t.fg("muted", " │ ")` separators, then wraps the entire string in `t.fg("dim", inner)`. If `Theme.fg()` uses SGR reset (`\e[0m`) at the end of each colored span — the common pattern — then the muted separator codes inside `inner` will reset the color after themselves, and subsequent text segments will render in the terminal's default color rather than dim. Only the first segment (before the first separator) would actually appear dim.

The old widget code colored each segment independently before concatenating (no nesting). If pi-tui's theme system doesn't support nested color spans, the fix is to do the same: wrap each part in `t.fg("dim", ...)` individually before joining.

### 3. Unused variable `act1vis`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `extensions/subagents/widget.ts:147`
- **Status:** open

`const act1vis = visibleWidth(act1)` is computed but never read. Likely a leftover from development — can be removed.

## No Issues

Plan adherence: no significant deviations found. All six steps were implemented as specified. The only differences from the plan are minor implementation details (e.g., dynamic left-fill in the bottom border vs. the plan's `╰──` fixed prefix), which are reasonable adaptations that preserve intent.
