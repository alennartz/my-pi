# Plan: Subagent State UI Revamp

## Context

Replace the minimalist one-line-per-agent subagent widget with a rich dashboard of color-coded box cards using WrapPanel layout, dense per-agent information, and an aggregate footer bar. See [brainstorm](../brainstorms/subagent-state-ui.md) for the full exploration.

## Architecture

### Impacted Modules

**Subagents Extension** — three files affected:

- **`widget.ts`** — Complete rewrite. The current pure function `renderGroupWidget(statuses, fg) → string[]` is replaced by a stateful `Component` class that implements `render(width): string[]` and `invalidate()`. The component holds a mutable reference to the current agent statuses, performs WrapPanel layout using the TUI-provided width, renders bordered box cards with state-colored borders, and appends an aggregate footer bar. Exposed via the factory variant of `setWidget`.

- **`group.ts`** — Small additions to `AgentStatus` and `handleRpcEvent`. Four new fields on `AgentStatus`:
  - `lastTurnInput: number` — raw `usage.input` from the most recent `message_end` (not cumulative; represents current context fill)
  - `contextWindow: number | undefined` — model's context window size, resolved via a callback when model ID is first seen
  - `hasSubgroup: boolean` — whether the agent has spawned its own sub-group
  - `waitingFor: string[]` — target agent IDs for active blocking sends (for channel wait-highlighting)

  `GroupManagerOptions` gains a `resolveContextWindow?: (modelId: string) => number | undefined` callback. Event handling additions: capture per-turn input tokens from `message_end`, resolve context window on first model ID, track `subagent`/`teardown_group` tool events for `hasSubgroup`, pass `to` through `setAgentWaiting` for `waitingFor`.

- **`index.ts`** — Widget setup changes. The `onUpdate` callback switches from calling `renderGroupWidget` + `setWidget(key, string[])` to updating the component's statuses + `tui.requestRender()`. The component is created via `setWidget(key, (tui, theme) => component)` factory variant. Widget creation is **gated on `parentLink === null`** — when the agent is an RPC child (recursive case), no widget code runs at all. The `resolveContextWindow` callback is wired from `ctx.modelRegistry`.

### Interfaces

**Widget component** — created by the `setWidget` factory, updated by `onUpdate`:

```typescript
class SubagentDashboard implements Component {
  // Called by onUpdate callback to push new data
  update(statuses: AgentStatus[]): void;

  // Component interface — called by TUI with actual terminal width
  render(width: number): string[];
  invalidate(): void;
}
```

The `onUpdate` callback captures the `tui` reference from the factory and calls `tui.requestRender()` after `update()`. When `parentLink` is set, the callback skips widget work entirely.

**Context window resolver** — threaded through GroupManagerOptions:

```typescript
interface GroupManagerOptions {
  // ... existing fields ...
  resolveContextWindow?: (modelId: string) => number | undefined;
}
```

Provided by the parent extension as a lookup against `ctx.modelRegistry`. Called once per unique model ID seen in `message_end` events; result cached on the AgentStatus.

**AgentStatus additions** — extends the existing interface in `group.ts`:

```typescript
interface AgentStatus {
  // ... existing fields ...
  lastTurnInput: number;
  contextWindow?: number;
  hasSubgroup: boolean;
  waitingFor: string[];
}
```

## Steps

**Pre-implementation commit:** `d8472f01e83e49522288a16fc0a748b3278d20aa`

### Step 1: Extend `AgentStatus` interface and initialization in `group.ts`

Add four new fields to the `AgentStatus` interface in `extensions/subagents/group.ts`:

```typescript
interface AgentStatus {
  // ... existing fields ...
  lastTurnInput: number;
  contextWindow?: number;
  hasSubgroup: boolean;
  waitingFor: string[];
}
```

Initialize them in the status creation block inside `start()` (the `const status: AgentStatus = { ... }` literal around line 143):
- `lastTurnInput: 0`
- `hasSubgroup: false`
- `waitingFor: []`
- (`contextWindow` is omitted — starts as `undefined`)

**Verify:** The `AgentStatus` interface has all four new fields. The status literal in `start()` initializes `lastTurnInput`, `hasSubgroup`, and `waitingFor` with their zero-values.
**Status:** done

### Step 2: Add `resolveContextWindow` to `GroupManagerOptions` in `group.ts`

Add the optional callback to the `GroupManagerOptions` interface in `extensions/subagents/group.ts`:

```typescript
interface GroupManagerOptions {
  // ... existing fields ...
  resolveContextWindow?: (modelId: string) => number | undefined;
}
```

No other changes needed — the callback is consumed in Step 3.

**Verify:** `GroupManagerOptions` has the new optional field. No callers break (the field is optional).
**Status:** not started

### Step 3: Update `handleRpcEvent` in `group.ts` — per-turn input, context window, and `hasSubgroup`

Three additions to the `handleRpcEvent` method in `extensions/subagents/group.ts`:

**A) Per-turn input tokens.** Inside the `message_end` handler block (around line 187), after the cumulative usage accounting, set `entry.status.lastTurnInput = usage.input || 0`. This captures the raw per-turn input (which represents current context fill) rather than accumulating it.

**B) Context window resolution.** Still inside the `message_end` handler, after setting `entry.status.model` from `msg.model`, add: if `entry.status.contextWindow` is undefined and `msg.model` is present and `this.opts.resolveContextWindow` exists, call `this.opts.resolveContextWindow(msg.model)` and assign the result to `entry.status.contextWindow`. This runs at most once per agent — subsequent turns find `contextWindow` already set and skip the call.

**C) `hasSubgroup` tracking.** In the existing `tool_execution_start` handler (around line 182), add: when `event.toolName === "subagent"`, set `entry.status.hasSubgroup = true`. When `event.toolName === "teardown_group"`, set `entry.status.hasSubgroup = false`. The existing handler already sets `lastActivity` and calls `onUpdate()`, so the `hasSubgroup` assignment goes in the same `if` block.

**Verify:** In the `message_end` block, `lastTurnInput` is assigned from `usage.input`, and `contextWindow` is resolved on first model sighting. In the `tool_execution_start` block, `hasSubgroup` flips on `subagent`/`teardown_group` tool names.
**Status:** not started

### Step 4: Track `waitingFor` targets in `group.ts`

**A) Add a private `correlationToTarget` Map** to the `GroupManager` class in `extensions/subagents/group.ts`:
```typescript
private correlationToTarget = new Map<string, string>();
```

**B) Update the broker `onBlockingSendStart` callback** in `start()` (around line 102) to pass the `to` argument through. Change from:
```typescript
onBlockingSendStart: (from, _to, correlationId) => this.setAgentWaiting(from, correlationId),
```
to:
```typescript
onBlockingSendStart: (from, to, correlationId) => this.setAgentWaiting(from, correlationId, to),
```

**C) Update `setAgentWaiting`** to accept `targetId: string` as a third parameter. Record the mapping `this.correlationToTarget.set(correlationId, targetId)` and push `targetId` onto `entry.status.waitingFor`.

**D) Update `clearAgentWaiting`** to look up the target via `this.correlationToTarget.get(correlationId)`, filter it from `entry.status.waitingFor`, and delete the correlation from the map.

**Verify:** `setAgentWaiting` populates both `pendingCorrelations` and `waitingFor`. `clearAgentWaiting` removes from both, using the correlation-to-target map for lookup. The broker callback passes `to` through.
**Status:** not started

### Step 5: Rewrite `widget.ts` as `SubagentDashboard` component

Complete rewrite of `extensions/subagents/widget.ts`. Remove the existing `renderGroupWidget` pure function and all its helpers. Replace with a `SubagentDashboard` class that implements the `Component` interface and exports a factory-compatible API.

**Class shape:**
```typescript
import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AgentStatus, AgentState } from "./group.js";

export class SubagentDashboard implements Component {
  private theme: Theme;
  private statuses: AgentStatus[] = [];
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme) { ... }
  update(statuses: AgentStatus[]): void { ... }
  render(width: number): string[] { ... }
  invalidate(): void { ... }
}
```

**Internal rendering pipeline** (all private methods):

1. **WrapPanel layout** — given `width`, compute box width and items-per-row. Minimum box width ~30 chars. Items per row = `Math.max(1, Math.floor((width + 1) / (minWidth + 1)))` where the +1 accounts for the 1-space gap. Actual box width = `Math.floor((width - (itemsPerRow - 1)) / itemsPerRow)` to distribute available space evenly.

2. **Box rendering** — each agent renders as a fixed 6-line box (2 border + 4 interior):
   - **Top border:** `╭` + ` id (turns)` + optional `"\uDB81\uDEA9"` for `hasSubgroup` in `accent` color + `─` fill + state icon (`⏳`/`✓`/`✗`/`⏸`) + ` ╮`. Failed agents use `╔═╗` double-line border with `═` fill instead.
   - **Line 1 (identity):** agent-def name (if any) + ` • ` + model name (truncated). Muted color.
   - **Line 2 (activity):** current `lastActivity` string, or state label ("idle", "failed", "waiting for response"). Truncated to box inner width.
   - **Line 3 (activity overflow):** continuation of activity if it exceeds one line, otherwise empty.
   - **Line 4 (channels):** reachable peers dot-separated (`coder · qa · parent`). When `waitingFor` is non-empty, waited-on agents are sorted first and highlighted in `warning` color; remaining peers in `dim`.
   - **Bottom border:** `╰──` + `ctx:XX%` (or raw `↑N` fallback if no `contextWindow`) + token stats (`↑Nk ↓Nk`) + cost (`$X.XX`) + `─` fill + `╯`. Failed uses `╚═╝` with `═` fill.

3. **State-colored borders** — border characters colored via `theme.fg()`: `accent` for running, `success` for idle, `warning` for waiting, `error` for failed.

4. **Dimming** — idle and failed agents render all interior text in `muted`/`dim` theme colors instead of their normal colors.

5. **Row stitching** — boxes in the same row are merged line-by-line with 1-space gaps between them, producing 6 output lines per row.

6. **Aggregate footer** — a single themed line below all rows: `── ctx: XX–YY% │ N agents: X running · Y idle · Z waiting │ $X.XX ──`. Uses `muted` for structural separators, `dim` for stats. Context range shows min–max of `lastTurnInput / contextWindow` across agents that have context data; omitted if no agents have context window info.

**Width handling:** every line produced by `render()` is guaranteed ≤ `width` using `truncateToWidth` from `@mariozechner/pi-tui`. The caching pattern (check `cachedWidth === width` and statuses reference identity) avoids redundant computation; `update()` calls `invalidate()` to bust the cache.

**Verify:** `widget.ts` exports `SubagentDashboard` class with `update()`, `render(width)`, and `invalidate()` methods. No remnant of the old `renderGroupWidget` function. The render output is 6 lines per row of boxes plus 1 footer line.
**Status:** not started

### Step 6: Update `index.ts` — factory widget, `parentLink` gate, and resolver wiring

Changes to `extensions/subagents/index.ts`:

**A) Update imports.** Remove the `renderGroupWidget` import from `./widget.js`. Add `SubagentDashboard` import from `./widget.js`. Add `TUI` type import from `@mariozechner/pi-tui`.

**B) Gate widget creation on `parentLink === null`.** Inside the `subagent` tool's `execute` method, before creating `GroupManager`, add a widget setup block that only runs when `!parentLink`:

```typescript
let dashboard: SubagentDashboard | null = null;
let tuiRef: TUI | null = null;

if (!parentLink) {
  ctx.ui.setWidget("subagents", (tui, theme) => {
    tuiRef = tui;
    dashboard = new SubagentDashboard(theme);
    return dashboard;
  });
}
```

**C) Change the `onUpdate` callback** from calling `renderGroupWidget` + `setWidget(key, string[])` to:
```typescript
onUpdate: () => {
  if (dashboard && tuiRef) {
    dashboard.update(group.getAgentStatuses());
    tuiRef.requestRender();
  }
},
```

**D) Wire `resolveContextWindow`** in the `GroupManagerOptions` passed to `new GroupManager(...)`:
```typescript
resolveContextWindow: (modelId: string) => {
  const all = ctx.modelRegistry.getAll();
  const found = all.find((m: any) => m.id === modelId);
  return found?.contextWindow;
},
```

**E) Update teardown cleanup.** In the `teardown_group` tool's execute method, the existing `ctx.ui.setWidget("subagents", undefined as any)` line correctly clears the factory-created widget. No change needed there.

**Verify:** `index.ts` no longer imports `renderGroupWidget`. The `setWidget` call uses the `(tui, theme) => Component` factory overload. The `onUpdate` callback calls `dashboard.update()` + `tui.requestRender()`. The `resolveContextWindow` callback resolves against `ctx.modelRegistry.getAll()`. When `parentLink` is set, no widget code runs.
**Status:** not started
