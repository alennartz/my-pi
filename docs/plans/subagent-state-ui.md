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
