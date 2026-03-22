# Subagent Rendering Investigation

## Status: Partially resolved

Two user-reported symptoms:
1. Widget takes forever to render after spawning agents; when it does, often comes with an immediate agent_complete
2. Notification text from completed agents appears as slow-scrolling white text "as if typing" — slower than normal LLM streaming

## Issue 1: Widget renders late (FIXED)

**Root cause:** In `startGroup()` (extensions/subagents/index.ts), the dashboard widget is created empty via `ctx.ui.setWidget()`, then `group.start()` runs and populates agent entries with initial statuses (state: "running"). But nobody calls `dashboard.update()` after `start()` returns. The dashboard's `doRender()` returns `[]` when `statuses.length === 0`, so the widget is invisible until the first RPC child emits an event (agent_start, tool_execution_start, etc.) — which requires each child pi process to spawn, load extensions, respond to get_state, receive its prompt, and start its LLM call. Fast agents can complete before slower ones even trigger their first event, explaining the "widget appears with immediate agent_complete" observation.

**Fix applied:** Added `dashboard.update(group.getAgentStatuses())` + `tuiRef.requestRender()` immediately after `group.start()` returns in `startGroup()`. Now all agents show as "running" the moment the tool call completes.

**Location:** extensions/subagents/index.ts, ~line 445 (after `const ack = await group.start();`)

## Issue 2: Slow notification text (ROOT CAUSE FOUND)

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
- If `sendCustomMessage` is called while `isStreaming === true`, the message is queued via steer/followUp rather than going through the `prompt()` path. However, this is **not** a semantic mismatch — the agent loop's `runLoop()` drains both steering and follow-up queues and triggers a new `streamAssistantResponse()` for each, so the turn happens regardless. The `triggerTurn` flag is simply redundant when the message is queued; the loop handles turn triggering inherently.
- Queuing can change *timing* (the turn is deferred until the drain point), but does **not** by itself explain permanent "purple missing" reports.

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

4. **Core rendering bug dropping custom-message display**
   Still plausible (fits "white appears, purple missing"), but unproven without hard event-vs-render evidence.

~~5. **Streaming-state branch mismatch in `sendCustomMessage`** — RULED OUT.
   Previously hypothesized that `triggerTurn` being "bypassed" during streaming was a semantic mismatch. Verified in agent-loop.js `runLoop()` that both steer and followUp queues drain into new `streamAssistantResponse()` calls — the turn happens regardless. The `triggerTurn` flag is redundant when queued, not ignored. Timing differences from deferred delivery remain possible but are covered by hypothesis #1.~~

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

### Root cause: LLM hallucination (2026-03-22)

Transcript analysis of the repro session revealed the "slow white text" is **not** a rendering or notification delivery bug. The LLM is **hallucinating agent responses**.

**What happens:**
1. LLM spawns agents (e.g. 7 scouts to read files)
2. Tool result returns "Group spawned: 7 agents"
3. Instead of waiting for real notifications, the LLM generates fake `<agent_complete>` blocks — 23K chars / 5730 output tokens of fabricated file content wrapped in notification XML
4. This streams out as slow white assistant text (~190 seconds)
5. Real notifications arrive later as proper `custom_message` entries (purple boxes) with the correct content

**Evidence the content is hallucinated, not echoed:**
- With `USE_STEER_DELIVERY=false`, notifications cannot reach the LLM during streaming (parentBusy guard blocks flush; flush only on agent_end)
- Diff of assistant text vs real notification for the same agent (read-decision-records) shows substantially different content: different section structure, missing headings, simplified text — the LLM reconstructed a plausible but wrong version from partial earlier context
- The hallucinated `<agent_complete>` blocks lack proper XML attributes (`id`, `status`) and use prose prefixes like "Agent read-planning completed:" instead
- The LLM later received the real notifications and noted "The scout returned a stale version" — attributing the differences to the scout rather than recognizing its own hallucination

**Fix applied:** Added two `promptGuidelines` to the `subagent` tool (extensions/subagents/index.ts):
1. Never fabricate/predict/simulate agent output — `<agent_complete>` and `<group_idle>` are system-delivered
2. Never echo/reproduce notification content — it's already visible to the user; respond with analysis and next actions instead

### Previous hypotheses (largely moot)

The hypotheses below were exploring notification delivery and rendering pipeline issues. With the root cause identified as LLM hallucination, most are no longer relevant to this specific symptom. They may still be worth investigating if separate notification rendering issues are observed.
