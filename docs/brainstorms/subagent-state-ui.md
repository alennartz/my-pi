# Subagent State UI Revamp

## The Idea

Revamp the subagent group status widget from its current minimalist one-line-per-agent text display into a rich, visually polished dashboard with per-agent box cards, color-coded state, and dense information layout. The dashboard sits persistently above the editor while agents run in the background.

## Key Decisions

### WrapPanel grid layout
**Chosen:** Boxes tile horizontally with a minimum width per box, wrapping to additional rows when the terminal isn't wide enough. Like a CSS flex-wrap container.
**Why:** Maximizes horizontal space usage. A wide terminal (170+ cols) can fit 5-6 boxes per row, keeping 10 agents to just 2 rows (~12 lines). Adapts gracefully to any terminal width without hardcoded column counts. Vertical compactness is critical because the user continues chatting with the primary agent while subagents run — the dashboard must coexist with conversation history.

### Fixed 6-line boxes (2 border + 4 interior)
**Chosen:** Every box is exactly 6 lines tall regardless of content.
**Why:** Variable-height boxes would cause visual jitter as agents transition between states or as activity strings change length. Fixed height means predictable, stable layout. The freed fourth interior line serves as activity overflow when tool call strings are long, and sits empty otherwise — breathing room, not waste.

### State encoded as border color, not text
**Chosen:** Border color communicates agent state: `accent` = running, `success` = idle, `warning` = waiting, `error` = failed. A small icon in the top-right corner (⏳/✓/✗/⏸) provides a secondary cue.
**Why:** Color is the fastest visual channel — you can assess group state at a glance without reading any text. Frees interior lines for actual information rather than status labels. The icon is redundant by design, for accessibility and for cases where color alone might be ambiguous.

### Rounded corners for normal boxes, double borders for failed
**Chosen:** Normal boxes use `╭─╮`/`╰─╯` rounded corners. Failed agents switch to `╔═╗`/`╚═╝` heavy double-line borders.
**Why:** Rounded corners look modern and softer. Double-line borders for failure create an unmistakable visual alarm — the box shape itself changes, not just the color. Failed agents visually scream without needing to read the word "failed."

### Idle/failed agents dim entirely
**Chosen:** When an agent goes idle or fails, the entire box content (not just specific fields) renders in `muted`/`dim` theme colors.
**Why:** Active agents pop visually while completed ones fade. The dashboard "breathes" — starts loud, quiets down as agents finish. Your eye is naturally pulled to the boxes that matter right now.

### Per-box content layout
```
╭ id (turns) 󱚩 ──────── ⏳ ╮      top border: id bold, turn count, recursive indicator, state icon
│ agent-def • model          │      line 1: identity (muted def + dim model)
│ bash(grep -rn "handleEv…   │      line 2: current activity or state label
│   src/extensions/sub…)     │      line 3: activity overflow (empty if not needed)
│ coder · qa · parent        │      line 4: reachable peers, dot-separated
╰── ctx:78% ↑1.2k ↓340 $0.02╯      bottom border: context fill %, token stats, cost
```
**Why — turn count in top border:** Turn count is a single small number. Putting it on its own interior line wastes space. Embedding it in the border as `(3)` next to the id is compact and scannable.
**Why — activity overflow:** Tool call strings (file paths, commands) are often the most informative part of the dashboard, and they're the most hurt by truncation. Two lines for activity means you can see `bash(grep -rn "handleEvent"` / `  src/extensions/subagents/...)` instead of just `bash(grep…)`.
**Why — task string excluded:** The full task string is too long and set at spawn time — you already know what you told the agents to do. Space is better used for dynamic state.
**Why — channels on own line with wait-highlighting:** When agent A is waiting on agent B, B's name appears first in A's channel list and is highlighted in `warning` color. The waited-on agent is sorted first specifically so it can never be truncated. This makes blocking-send dependencies visible at a glance without a dedicated "waiting for" field.

### Context window fill level as primary metric
**Chosen:** Show current context window usage as a percentage (`ctx:78%`) in per-agent bottom border, and as a range (`ctx: 34–82%`) in the aggregate footer.
**Why:** Context fill is the most actionable runtime metric — it tells you if an agent is approaching its limit and might need compaction or attention. Cumulative token counts and cost are secondary. The data is available: `Usage.input` on each `message_end` event gives the current turn's full context consumption, and `Model.contextWindow` gives the max.

### Recursive subgroup indicator: 󱚩 (nerdfont robot)
**Chosen:** When an agent has spawned its own sub-group of agents, a 󱚩 icon appears in the top border in `accent` color.
**Why:** Recursive agent spawning is one of the most complex runtime behaviors and was previously invisible. The robot icon is visually distinct, legible at any font size, and thematically appropriate. Tracked by watching `tool_execution_start` events — `subagent` tool means sub-group started, `teardown_group` means it ended.

### Dot separators between channel names
**Chosen:** `coder · qa · parent` instead of `coder  qa  parent`.
**Why:** Cleaner visual parsing — the dots make it unambiguous where one name ends and the next begins, especially with variable-length agent ids.

### Aggregate footer bar
**Chosen:** A single themed line below all boxes: `── ctx: 34–82% │ 6 agents: 3 running · 2 idle · 1 waiting │ $0.24 ──`
**Why:** Grounds the whole dashboard with a summary. Context range is the headline (most actionable), agent state counts give group-level progress, total cost for budget awareness.

## Direction

Replace the current `renderGroupWidget` function and its simple `string[]` output with a width-aware render function variant of `setWidget`. The new renderer:

1. Computes box layout using WrapPanel logic (min-width per box, pack per row, wrap)
2. Renders each agent as a bordered card with state-colored rounded corners (or double-line for failed)
3. Embeds id, turn count, and recursive indicator in top border; token stats in bottom border
4. Shows identity, activity (with overflow), and channels in interior lines
5. Dims idle/completed agents
6. Renders an aggregate footer bar with context range, state counts, and total cost

Requires small additions to `AgentStatus`: `lastTurnInput` (updated per message_end, not cumulative) and `contextWindow` (from model metadata). Also needs `hasSubgroup` boolean tracked via tool execution events.

## Open Questions

- **Minimum box width**: Needs experimentation. Probably ~28-30 chars to fit the content meaningfully, but the exact number depends on typical agent id lengths and model name abbreviation.
- **Model name abbreviation**: Full model ids can be long (`claude-sonnet-4-20250514`). We'll likely need a truncation or abbreviation strategy. Could strip dates, use short aliases, or truncate with ellipsis.
- **Context window fallback**: If `contextWindow` can't be resolved (e.g., model metadata unavailable), fall back to showing raw input tokens without a percentage.
- **Gap between boxes**: 1 space? 2 spaces? 3? Needs visual tuning in practice.
