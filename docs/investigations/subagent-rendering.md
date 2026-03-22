# Subagent Rendering Investigation

## Status: Partially resolved

Two user-reported symptoms:
1. Widget takes forever to render after spawning agents; when it does, often comes with an immediate agent_complete
2. Notification text from completed agents appears as slow-scrolling white text "as if typing" — slower than normal LLM streaming

## Issue 1: Widget renders late (FIXED)

**Root cause:** In `startGroup()` (extensions/subagents/index.ts), the dashboard widget is created empty via `ctx.ui.setWidget()`, then `group.start()` runs and populates agent entries with initial statuses (state: "running"). But nobody calls `dashboard.update()` after `start()` returns. The dashboard's `doRender()` returns `[]` when `statuses.length === 0`, so the widget is invisible until the first RPC child emits an event (agent_start, tool_execution_start, etc.) — which requires each child pi process to spawn, load extensions, respond to get_state, receive its prompt, and start its LLM call. Fast agents can complete before slower ones even trigger their first event, explaining the "widget appears with immediate agent_complete" observation.

**Fix applied:** Added `dashboard.update(group.getAgentStatuses())` + `tuiRef.requestRender()` immediately after `group.start()` returns in `startGroup()`. Now all agents show as "running" the moment the tool call completes.

**Location:** extensions/subagents/index.ts, ~line 445 (after `const ack = await group.start();`)

## Issue 2: Slow notification text (NOT RESOLVED)

### What we know about the rendering pipeline

When `flushNotifications()` fires, it calls:
```
pi.sendMessage({ customType: "subagents", content: xml, display: true }, { triggerTurn: true })
```

There are **two distinct internal delivery paths** for extension custom messages (`sendCustomMessage` in `agent-session.js`):

1. **Direct append/emit path** (`!isStreaming && !triggerTurn`)
   - `agent.appendMessage(appMessage)`
   - immediate `_emit(message_start)` + `_emit(message_end)`
   - no LLM turn

2. **Agent-loop path** (`triggerTurn: true` and/or streaming queueing)
   - when idle + trigger: `await agent.prompt(appMessage)`
   - when streaming: queues via `agent.steer(appMessage)` / `agent.followUp(appMessage)`
   - events are emitted by agent loop processing

Subagents flush uses `triggerTurn: true`, so it intentionally uses path #2.

For the idle+trigger case, the loop does:

1. Emits `message_start` for the custom message (role: "custom") → expected purple box in TUI via `CustomMessageComponent`
2. Calls the LLM with notification content converted to user role (`convertToLlm` maps `custom` → `user`)
3. Streams assistant response as white text (`AssistantMessageComponent`)

Important nuance discovered:
- If `sendCustomMessage` is called while `isStreaming === true`, the `triggerTurn` option is effectively bypassed and message is queued via steer/followUp branch. This is a semantic mismatch/footgun and can change timing.
- This should delay purple in some races, but does **not** by itself explain permanent "purple missing" reports.

### Additional observations from recent testing

- User-observed behavior: in some runs the orchestrator stayed busy (e.g. repeatedly calling `check_status`), notifications accumulated, and final delivery looked correct. This suggests queue/coalescing timing may improve visible behavior.
- Temporary deep tracing was attempted in Pi internals (`agent-session.js`, `interactive-mode.js`) but reverted after repro became inconsistent. Current workspace does **not** retain those instrumentation edits.

### Hypothesis ranking (current)

Provisional ranking based on current evidence (highest likelihood first):

1. **Notification turn fragmentation / timing churn**
   Multiple small `triggerTurn` flushes and racey busy/idle timing create inconsistent visual behavior. This matches observed runs where natural queueing/coalescing looked better.

2. **Event/render pipeline backpressure**
   Serialized event handling (`_agentEventQueue`) plus interactive rendering cost can make assistant white-text updates feel abnormally slow.

3. **Large notification payload echo cost**
   Large `<agent_complete>` payloads increase both model latency and UI rendering cost.

4. **Streaming-state branch mismatch in `sendCustomMessage`**
   When `isStreaming === true`, `triggerTurn` is effectively bypassed in favor of steer/followUp queueing. This likely contributes timing variance but is unlikely to fully explain persistent "purple missing" by itself.

5. **Core rendering bug dropping custom-message display**
   Still plausible (fits "white appears, purple missing"), but unproven without hard event-vs-render evidence.

### What we don't know

The user reports white text appearing "slower than LLM streamed responses" and "as if I was typing it." Possible causes not yet investigated:

1. **Event queue serialization:** Pi's `_agentEventQueue` (agent-session.js ~line 207) processes ALL agent events through a sequential promise chain. Every streaming `message_update` event goes through: Agent.emit → _handleAgentEvent → queue → _processAgentEvent → await _emitExtensionEvent → _emit (to interactive mode). If anything in this chain is slow for any event, it delays ALL subsequent events including streaming updates.

2. **Large notification content:** The `<agent_complete>` XML includes the full `lastOutput` of the agent. If the agent produced a very long response, the notification is huge. The LLM processes this as a user message and generates a response — which could be slow due to large input context.

3. **Multiple rapid turns:** Each notification flush triggers a new LLM turn. If notifications arrive in quick succession, the user sees: purple box → short LLM response → purple box → short LLM response → etc. Each turn has API latency overhead.

4. **TUI render throughput:** If widget `onUpdate` calls `tui.requestRender()` frequently (agents are active, lots of tool calls), and each render is expensive (complex widget + streaming + large chat), renders could be slow.

5. **Compaction interference:** After `agent_end`, pi's `_processAgentEvent` checks for auto-compaction (agent-session.js ~line 295). If compaction triggers, it involves an LLM call. Meanwhile, the fire-and-forget `sendCustomMessage` is also trying to start a new turn. Unclear how these interact.

### Defensive fix applied (parentBusy guard)

Added `if (parentBusy) return;` at the top of `flushNotifications()`. This prevents the 100ms debounce timer from flushing mid-turn. The scenario: notification arrives while parent is idle → debounce timer starts → within 100ms something else starts a turn → `parentBusy` becomes true via `agent_start` extension handler → but the handler is async (goes through `_agentEventQueue`) so `parentBusy` might not be set yet when the timer fires. The guard is correct defensively but may not be the cause of the slow-text symptom.

**Location:** extensions/subagents/index.ts, `flushNotifications()` function

### Key files for further investigation

- `extensions/subagents/index.ts` — notification queue, flush logic, parentBusy tracking
- Pi's `agent-session.js` — `sendCustomMessage` (~line 894), `_processAgentEvent` (~line 236), `_agentEventQueue` (~line 207), `_handleAgentEvent` (~line 199)
- Pi's `agent-loop.js` (pi-agent-core) — `runAgentLoop`, event emission, steering message processing
- Pi's `messages.js` — `convertToLlm` (~line 75) converts custom messages to user role for LLM
- Pi's `interactive-mode.js` — event handling (~line 1751), `addMessageToChat` (~line 2035), `CustomMessageComponent` rendering

### Repro session

Session file with a fresh reproduction of the slow-streaming/raw-text symptom (2026-03-22):
`/home/alenna/.pi/agent/sessions/--home-alenna-repos-my-pi--/2026-03-22T16-16-35-352Z_af5e88eb-eb74-491f-8a6b-de2339011863.jsonl`

Context: spawned 7 scout agents to read skill files. On completion, the `<agent_complete>` notifications streamed out as slow white text instead of rendering through the custom message component.

### Next steps to try

- Reproduce with a minimal scenario that isolates notification delivery (e.g. two fast agents + one slow agent) and capture exact event ordering around `message_start(custom)` vs `message_start/message_update(assistant)`.
- Verify whether "purple missing" runs have missing custom events or only missing custom rendering.
- Check whether slow white text correlates with large `lastOutput` payloads in `<agent_complete>`.
- Check whether multiple notification-triggered turns happen in rapid succession (small batches vs one coalesced batch).
- If reproducible, re-introduce short-lived file-based tracing (not TUI console output) at `sendCustomMessage` and interactive `handleEvent`.
