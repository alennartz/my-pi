# Plan: Subagent Status Recomputation on Session Resume

## Context

When a parent pi session is resumed, the subagents extension re-spawns its child agents from their persisted session files via `restoreFromPersistence`. Every restored agent is currently seeded with `state: "running"` and zeroed runtime status (usage, model, lastOutput), so the widget, panel cards, and `check_status` all report stale/incorrect status until the agent happens to run another turn. This change makes restored status faithful by recomputing every UI/status-facing field from the source of truth — the child's own session file — rather than trusting the seed or replicating a snapshot into our persistence log.

(No brainstorm file — the design was settled through investigation conversation. See DR-014, DR-033 for prior persistence/restore decisions this builds on.)

## Architecture

### Impacted Modules

**Subagents** (`extensions/subagents/`) — the only module touched.

- `agent-set.ts` (`SubagentManager`): the restore path stops asserting a fabricated status. Today `start()` unconditionally seeds `status.state = "running"` and zeroed `usage`. For restored entries (the `this.restoring` branch), it instead seeds from a recomputed snapshot of the child session file, with `state: "idle"`. Fresh-spawn behavior is unchanged (still `running`, since a task prompt is about to drive a turn).
- New dependency on the `session-snapshot` module (below) for the parse.
- Reuses existing `persistence.getPersistencePaths` + `loadPersistedAgents` to recompute `hasSubgroup` from the child's own subagent log.

Two design invariants this preserves:

- **No idle-marker coupling.** The `session-resume` extension owns the `session-idle`/`session-resumed` protocol and decides whether a resumed child runs. Subagents must not read or interpret that marker. Seeding `idle` and letting the child's emitted `agent_start`/`agent_end` events drive the transition keeps the two extensions decoupled: an idle-at-shutdown child stays idle (no events arrive); a child with pending work auto-resumes, emits `agent_start`, and the parent flips it to `running` naturally.
- **Recompute over replicate** (extends DR-033). The session file is the source of truth for runtime status. We do not add usage/model/output fields to `PersistedAgentRecord`; that would duplicate data that can drift. The marginal cost of re-parsing is negligible because the resumed child *already* reads and replays its entire session file on resume — the parent's extra single pass is strictly cheaper than what the child does anyway.

### New Modules

**session-snapshot** (`extensions/subagents/session-snapshot.ts`)

Purpose: reconstruct the runtime-status fields of an agent from its persisted pi session JSONL file, in a single forward pass.

Responsibilities:
- Read the session file line by line.
- Cheaply pre-filter each line by substring before parsing, so the large lines (`toolResult` payloads, embedded images, user content) are skipped without a full `JSON.parse`. Only lines that look like assistant messages and session/marker lines are parsed.
- Accumulate cumulative usage across all assistant messages (inherently requires visiting every assistant line — a tail read cannot produce correct totals).
- Capture the last assistant message's model and text, and that turn's input-side token count.

Dependencies: Node `fs` only. No dependency on `pi`'s session-manager API (the file is parsed directly, as `persistence.ts` already does for the lifecycle log). Pure and synchronous — trivially unit-testable with fixtures.

Location: alongside the other Subagents helper modules.

### Interfaces

#### `session-snapshot.ts`

```ts
export interface SessionSnapshot {
  /** Cumulative usage summed over every assistant message in the session. */
  usage: {
    input: number;        // sum of usage.input
    output: number;       // sum of usage.output
    cacheRead: number;    // sum of usage.cacheRead
    cacheWrite: number;   // sum of usage.cacheWrite
    cost: number;         // sum of usage.cost.total
    turns: number;        // count of assistant messages
  };
  /** Model id of the last assistant message, if any. */
  model?: string;
  /** Text of the last assistant message's last text part, if any. */
  lastOutput?: string;
  /** Input-side tokens of the last assistant turn: input + cacheRead + cacheWrite. */
  lastTurnInput: number;
}

/**
 * Parse a pi session JSONL file into a status snapshot via a single forward pass.
 *
 * Behavioral contract:
 * - A missing, empty, or unreadable file yields a zeroed snapshot
 *   ({ usage: all-zero, turns: 0, lastTurnInput: 0 }, no model/lastOutput) — never throws.
 * - Malformed (non-JSON) lines are skipped individually; a single bad line does
 *   not abort the parse.
 * - Only assistant messages contribute to usage. usage.turns equals the number of
 *   assistant messages seen.
 * - model and lastOutput reflect the LAST assistant message in file order. If the
 *   last assistant message has no text part, lastOutput is left at the previous
 *   value (or undefined if none). model is taken from that same last assistant message.
 * - lastTurnInput is derived from the last assistant message's usage as
 *   (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0).
 * - Lines that cannot be an assistant message (cheap substring check fails) are
 *   skipped without JSON parsing, so large toolResult/image lines cost ~nothing.
 */
export function parseSessionSnapshot(sessionFile: string): SessionSnapshot;
```

Session-file entry shapes the parser must handle (observed format, pi `--mode rpc` session JSONL):

```jsonc
// assistant message line (the only kind that contributes to usage)
{ "type": "message",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-8",
    "content": [ { "type": "text", "text": "..." }, ... ],
    "usage": { "input": 2, "output": 408, "cacheRead": 40475,
               "cacheWrite": 2086, "cost": { "total": 0.0434 } } } }

// non-assistant lines (skipped via substring pre-filter):
// { "type": "message", "message": { "role": "user", ... } }
// { "type": "message", "message": { "role": "toolResult", ... } }   // often the largest
// { "type": "session", ... } / model_change / thinking_level_change / custom markers
```

#### `agent-set.ts` restore seeding (contract change)

The restore path seeds the `AgentStatus` from the snapshot instead of zeros, and uses `state: "idle"`:

```
on restore (this.restoring === true), for each restored entry with a known session file:
  snap   = parseSessionSnapshot(sessionFile)
  status = {
    ...identity fields (id, agentDef, task, channels) as today,
    state:          "idle",                                   // was "running"
    usage:          snap.usage,                               // was all-zero
    model:          snap.model,                               // was undefined
    lastOutput:     snap.lastOutput,                          // was undefined
    lastTurnInput:  snap.lastTurnInput,                       // was 0
    contextWindow:  snap.model ? resolveContextWindow(snap.model) : undefined,
    hasSubgroup:    childHasLiveSubagents(sessionFile),       // was false
    lastActivity:   undefined,                                // transient — correctly empty
    pendingCorrelations: [],                                  // broker state — gone on restart
    waitingFor:     [],                                       // broker state — gone on restart
  }
```

`childHasLiveSubagents(sessionFile)` recomputes the subgroup flag from the child's own
persistence log without replication:

```
childHasLiveSubagents(childSessionFile):
  paths = getPersistencePaths(childSessionFile)         // existing persistence helper
  loaded = loadPersistedAgents(childSessionFile)        // existing; null if no log
  return loaded !== null && loaded.agents.length > 0
```

Fresh-spawn seeding (the `!this.restoring` path) is unchanged: `state: "running"`, zeroed usage, fields populated by the live RPC event stream as turns run.

Event-driven transitions are unchanged: when a restored child auto-resumes (driven by its
own `session-resume` extension), `handleRpcEvent` receives `agent_start` → `state = "running"`,
then `agent_end` → `state = "idle"`, exactly as for a live agent. The `idle` seed is the correct
resting state in between.

## Tests

**Pre-test-write commit:** `ac24d03f801fdec0abdd699a7f08b711794150c5`

### Interface Files

- `extensions/subagents/session-snapshot.ts` — defines the `SessionSnapshot` interface (cumulative usage, last-message model/output, last-turn input tokens) and the `parseSessionSnapshot(sessionFile)` function signature with its full behavioral contract documented in the docstring. Implementation is a `throw new Error("not implemented")` stub.

### Test Files

- `extensions/subagents/session-snapshot.test.ts` — fixture-based behavioral tests for `parseSessionSnapshot`. Each test writes a synthetic pi session JSONL file to a temp dir and asserts on the returned snapshot. Covers degenerate inputs, malformed lines, cumulative usage, last-assistant-message capture, last-turn input derivation, and non-assistant noise filtering.

### Behaviors Covered

#### `parseSessionSnapshot` (session-snapshot.ts)

- **Degenerate inputs yield a zeroed snapshot, never throw.** Missing file, empty file, an unreadable file (directory path → EISDIR), and a session with no assistant messages all produce `usage` all-zero, `turns: 0`, `lastTurnInput: 0`, and undefined `model`/`lastOutput`.
- **Malformed lines are skipped individually.** A non-JSON line does not abort the parse; surrounding valid assistant data is still captured.
- **Cumulative usage sums over every assistant message.** `input`/`output`/`cacheRead`/`cacheWrite`/`cost` are summed across all assistant messages; `turns` counts assistant messages. Missing usage sub-fields count as zero. An assistant message with no usage block still counts as a turn (zero contribution). Usage on non-assistant messages (user/toolResult) is ignored.
- **`model` and `lastOutput` reflect the last assistant message in file order.** When the last assistant message has multiple text parts, `lastOutput` is its last text part. When the last assistant message has no text part, `lastOutput` keeps the previous assistant message's text (or stays undefined if none ever had text), while `model` still comes from that last assistant message.
- **`lastTurnInput` is derived from the last assistant turn** as `input + cacheRead + cacheWrite`, excluding output tokens; a last assistant message with no usage block yields `lastTurnInput: 0`.
- **Non-assistant noise is filtered.** User, toolResult, session, and marker lines are ignored while assistant usage/model/output are still captured correctly.

**Review status:** approved

## Steps

**Pre-implementation commit:** `a3edd787e5ddb7e7f0846e328239da4debe20875`

### Step 1: Implement `parseSessionSnapshot` in `session-snapshot.ts`

Replace the `throw new Error("not implemented")` stub body of `parseSessionSnapshot(_sessionFile: string)` in `extensions/subagents/session-snapshot.ts` with a real single-forward-pass parser. The exported `SessionSnapshot` interface and the function signature are already defined and immutable — only the body changes (rename `_sessionFile` → `sessionFile`).

Behavior to satisfy (per the docstring contract and `session-snapshot.test.ts`):

- Read the file with `fs.readFileSync(sessionFile, "utf8")` inside a `try/catch`. Any read failure (missing file → ENOENT, directory path → EISDIR, unreadable) returns a zeroed snapshot: `usage` all-zero with `turns: 0`, `lastTurnInput: 0`, no `model`, no `lastOutput`. Never throws.
- Split on `\n`, skip empty/whitespace-only lines.
- **Cheap substring pre-filter before `JSON.parse`:** only attempt to parse a line that can be an assistant message. A line that does not contain the assistant-role marker substring (e.g. `"role":"assistant"`) is skipped without parsing, so large `toolResult`/image lines cost ~nothing. Note session lines use compact JSON (no spaces), matching the test fixtures' `JSON.stringify` output — choose a substring that holds for that format.
- Wrap each per-line `JSON.parse` in `try/catch`; a malformed line is skipped individually and does not abort the pass.
- For each parsed line, confirm it is an assistant message (`line.type === "message" && line.message?.role === "assistant"`) before treating it as a turn — the substring pre-filter is a fast reject, not proof.
- For every assistant message: increment `usage.turns`; add `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite` (each `?? 0`) and `usage.cost?.total ?? 0` into the running totals. An assistant message with no `usage` block still counts as a turn with zero contribution.
- Track the last assistant message in file order: set `model` from its `message.model` (even if it has no text). For `lastOutput`, scan that message's `content` for `type === "text"` parts and take the **last** text part; if the message has no text part, leave `lastOutput` at its previous value (do not clear it).
- Set `lastTurnInput` from the last assistant message's usage as `(input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)`, excluding output. A last assistant message with no usage block yields `lastTurnInput: 0`.
- Ignore usage/model/text on any non-assistant message (user, toolResult, session, marker lines).

**Verify:** `npx vitest run extensions/subagents/session-snapshot.test.ts` passes all cases (degenerate inputs, malformed lines, cumulative usage, last-assistant capture, lastTurnInput, non-assistant noise).
**Status:** done

### Step 2: Add `childHasLiveSubagents` helper and snapshot-based restore seeding in `agent-set.ts`

Two changes in `extensions/subagents/agent-set.ts`:

**(a) Import the snapshot parser.** Add `import { parseSessionSnapshot } from "./session-snapshot.js";` alongside the existing module imports.

**(b) Add a private helper** `childHasLiveSubagents(childSessionFile: string): boolean` on `SubagentManager` that recomputes the subgroup flag from the child's own persistence log without replication:

```ts
private childHasLiveSubagents(childSessionFile: string): boolean
```

It calls the existing `loadPersistedAgents(childSessionFile)` and returns `loaded !== null && loaded.agents.length > 0`. (`getPersistencePaths` is already imported and is invoked internally by `loadPersistedAgents`; no separate call is needed beyond what the contract in the architecture sketches.)

**(c) Branch the status seed in `start()`.** In the per-agent loop where `const status: AgentStatus = { state: "running", ... }` is built, the session file for a restored agent is available from `agentSpec.resumeSessionFile` (set for both `kind: "agent"` and `kind: "fork"` restore specs by `toRestoreSpec`). When `this.restoring` is true and a session file path is known, build the status from a snapshot instead of the fresh-spawn defaults:

```
const restoreFile = this.restoring ? agentSpec.resumeSessionFile : undefined;
if (restoreFile) {
  const snap = parseSessionSnapshot(restoreFile);
  status = {
    id, agentDef, task, channels,           // identity fields, same as fresh path
    state: "idle",                           // was "running"
    usage: snap.usage,
    model: snap.model,
    lastOutput: snap.lastOutput,
    lastTurnInput: snap.lastTurnInput,
    contextWindow: snap.model ? this.opts.resolveContextWindow(snap.model) : undefined,
    hasSubgroup: this.childHasLiveSubagents(restoreFile),
    pendingCorrelations: [],
    waitingFor: [],
    // lastActivity left undefined (transient)
  };
}
```

Keep the existing fresh-spawn object (`state: "running"`, zeroed `usage`, `hasSubgroup: false`, etc.) as the `!this.restoring` path unchanged. The identity fields (`id`, `agentDef`, `task`, `channels`) are computed identically in both branches — factor them so both objects stay in sync, or duplicate them; either is fine as long as the only differences are the snapshot-derived fields and `state`.

Do **not** touch: the fresh-spawn task-prompt suppression (`if (!this.restoring)`), `appendAgentAdded` gating, event-driven transitions in `handleRpcEvent` (a restored child that auto-resumes still flips `idle → running` on `agent_start` and back on `agent_end`), or `PersistedAgentRecord` (no new fields — recompute over replicate).

**Verify:** Code reads correctly against the architecture's restore-seeding contract. No type-check step exists for this project (extensions are raw TS loaded at runtime); confirm by inspection that the restore branch produces an `AgentStatus` with every required field, that `state` is `"idle"`, and that the fresh-spawn path is unchanged in behavior. Existing `session-snapshot.test.ts` still passes (Step 1 unaffected).
**Status:** done
