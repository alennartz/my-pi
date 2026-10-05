# Plan: Session-Owned Subagent State

## Context

Subagent lifecycle state is currently split between the shared `AgentSessionRegistry`, a replaceable `SubagentManager`, and mutable variables captured by the extension’s tool and event callbacks. When the last child is torn down, the manager wrapper closes its router and sets `manager = null`; a concurrent spawn can still finish on the old manager while the shared registry records its child. Status then sees the child, but routing may use no manager or a new manager without that route.

The fix is to make state ownership follow the root or child session that uses it. Manager and router identity last for that session, while each mutable value has one explicit owner and callbacks delegate to those owners instead of closing over loose mutable variables.

## Architecture

### Impacted Modules

- **Subagents extension** — one `SubagentSessionOwner` per root or child extension scope. It owns the session’s manager reference, session environment, turn/notification coordination, message-reply bookkeeping, and references to presentation and registry owners. Its manager and router are created during `session_start` and retained until `session_shutdown`; an empty child set is not a reason to replace either object.
- **`AgentSessionRegistry`** — remains the single canonical owner of the root-relative agent tree, managed child-session objects, and immutable operational snapshots. The root scope creates and disposes it; child scopes borrow it. The redesign does not move child-session ownership into `SubagentManager`.
- **`SubagentManager`** — remains the per-scope coordinator for direct children: spawn, restore, teardown, persistence records, and direct-child status projection. Its existing mutation queue continues to order lifecycle mutations, but its identity no longer changes when its last child is removed.
- **`MessageRouter`** — becomes the long-lived routing authority for that manager’s scope. Its route table starts empty except for the parent endpoint, changes as agents are added or removed, and is closed only at session shutdown. It owns its mutable route table rather than sharing a mutable topology map with the manager.
- **Presentation and notification behavior** — display state and turn/notification state gain explicit owners. Their behavior remains the same; only the location and access path of their state change.

### New Modules

**`SubagentSessionOwner` (per-scope owner).** This is the explicit owner for state currently held in the extension factory’s outer variables. It is created for each extension instance and initialized once from the `ExtensionContext` supplied at `session_start`. It creates the root registry or accepts the child scope’s registry, captures the session environment, and creates one `SubagentManager` and one `MessageRouter`. It owns shutdown and prevents commands from starting after shutdown begins.

The owner may contain small focused state holders rather than one large record:

- **`SessionEnvironment`** — a fixed snapshot of package-agent discovery and model-completion data loaded at session start.
- **`SubagentPresentation`** — TUI dashboard, Pimote panel, session-name display, and the registry subscription that refreshes them.
- **`SessionTurnCoordinator`** — notification queue, `await_agents` wait, stop-sequence handling, and per-turn abort/error state.
- **`IncomingMessageState`** — subscriptions for inbound parent/uplink messages and the correlation-ID-to-exact-port table used by `respond`.

These can remain private parts of the Subagents module; the architecture does not require each to become a separately exported package or class.

### Interfaces

#### Session lifetime

```ts
type SessionPhase =
  | { kind: "before-start" }
  | { kind: "active"; session: ActiveSubagentSession }
  | { kind: "shutting-down" };

interface ActiveSubagentSession {
  readonly environment: SessionEnvironment;
  readonly registry: AgentSessionRegistry;
  readonly manager: SubagentManager;
  readonly presentation: SubagentPresentation;
  readonly turns: SessionTurnCoordinator;
  readonly incomingMessages: IncomingMessageState;
}

interface SubagentSessionOwner {
  start(ctx: ExtensionContext): Promise<void>;       // once, on session_start
  handlePiEvent(event: SessionEvent, ctx: ExtensionContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;    // once, on session_shutdown
}
```

This sketch shows lifecycle entry points, not exact SDK type names. The existing tools keep their distinct schemas and results; their registered functions delegate to named operations on this per-session owner. Event handlers pass event data and the current `ctx` to the owner. They do not read a free-standing `manager`, `queue`, map, or UI variable. The owner’s manager reference is installed once during `start` and never replaced; its session phase is explicit rather than inferred from `manager === null`.

The mutable-state rule is about ownership, not eliminating all runtime state: a queue must queue messages and a router must change routes. Their state lives behind named owner methods. References to those owners and to the manager/router are `const`/`readonly` wherever construction timing permits.

#### Manager and router

- One `SubagentManager` exists for the lifetime of a root or child scope. A child scope owns a manager for its own direct children while borrowing the root’s `AgentSessionRegistry`.
- `teardown(agentId?)` removes children from the registry and asks the router to remove their endpoints/routes. Removing the last child leaves the same manager and router alive.
- `softShutdown()` removes live descendants when the session ends. The root owner then disposes the registry; a child owner does not dispose the registry it borrows.
- The router owns route topology. Its initial state is a live parent endpoint with no child destinations (`parent → {}`). Adding/removing agents mutates the router’s private route table through explicit operations. `close()` is terminal and is reserved for session shutdown.
- Empty routes and closed router are distinct states: an empty router rejects sends to absent children but can accept newly added routes; a closed router rejects all future connections and sends.
- The manager must not use `router === null` to mean “no children” or “not restored.” Child presence comes from the registry/manager’s child records. Restore-on-resume uses explicit restore state. A failed spawn removes only its staged routes and leaves the parent-only router available for a later spawn.

#### Mutable-state ownership map

| Current state | Owner in the proposal | Contract |
|---|---|---|
| `manager` | `SubagentSessionOwner` | Construct once at session start; keep the same identity until shutdown. Never clear it when the last child is removed. |
| `registry` | Root `SubagentSessionOwner` / `AgentSessionRegistry` | Root creates and disposes it. Child scopes hold a fixed borrowed reference. It remains canonical for all tree membership and status. |
| `router`, parent endpoint, topology | `MessageRouter` | One router object per scope session. The router alone mutates its route table; it begins empty and closes only at shutdown. |
| `registryUnsubscribe` | `SubagentPresentation` | Keep the tree-display subscription for the session; release it at shutdown, not on an empty child set. |
| `uplinkUnsubscribe` | `IncomingMessageState` | Child-scope inbound-message subscription; release it at shutdown. The manager/router owns its own parent-endpoint listener. |
| `dashboard`, `panelHandle`, `tuiRef` | `SubagentPresentation` | Own mount/unmount and render state. UI is projected from registry snapshots; other modules do not mutate handles. |
| `queue`, `waitState`, `stopSequences` | `SessionTurnCoordinator` | Preserve current notification batching, `await_agents` resolution, abort parking, and stop-sequence behavior behind methods. |
| `rootOperational` | Root registry snapshot | Remove the second mutable root-status copy. The registry remains the one source for root and child status. |
| `rootRunError`, `runAborted` | `SessionTurnCoordinator` | Keep only transient current-turn data; fold the resulting settled state into the registry snapshot. |
| `correlationOrigin` | `IncomingMessageState` | Map each pending public correlation ID to the exact `MessagePort` that delivered it. `respond` uses that port, never a later manager lookup. |
| `skillPathsMap` | Removed | Resolve paths while preparing a spawn and put them on that spawn’s immutable agent specification. No cross-call map keyed by agent ID. |
| `notifiedTierIssues` | `SessionTurnCoordinator` notice state | Keep “notify once” deduplication inside the existing session notification owner rather than a loose set. |
| `cachedPackageAgents`, `cachedModels` | `SessionEnvironment` | Build once at session start and retain as a fixed snapshot for the session. |

#### Callback ownership

Pi still requires functions for tools, commands, and events. Those registrations are necessary adapters, not the state owners. Each adapter delegates to the stable `SubagentSessionOwner` instance; it does not close over changing local variables. Internal `SubagentManager` hooks (`onUpdate`, `onAgentComplete`, `onParentMessage`) and router hooks (`onBlockingSendStart`, `onBlockingSendEnd`) call methods on stable typed event receivers. The context-window lookup is supplied as an explicit model-catalog dependency. Router and registry subscriptions deliver events to their designated owners, which hold their own unsubscribe handles.

A blocking message records its origin when received. The receiver passes the exact `MessagePort` alongside the message; the response owner stores that port with the correlation ID. This removes the current `getLocalParentPort()` lookup through a later “current manager.”

#### Model selection

For every fresh spawn, preserve current expected precedence: a pinned model in the agent definition wins; otherwise an explicitly requested model wins; if neither is present, use the parent session’s active model at that spawn. A post-teardown spawn reads the parent’s model from that invocation’s `ctx`; it does not reuse an earlier manager’s value. `resurrect` continues to use the resumed child session’s persisted model. No quota-bypass persistence is introduced; DR-045 remains in force.

#### Behavioral contracts

- After tearing down the last child, the same manager and router remain available with zero child routes. A subsequent spawn adds routes to those same session-owned objects.
- Concurrent spawn and teardown operations use the same manager’s existing mutation ordering. Status and message routing must agree on the resulting child set.
- A late event from a removed child cannot update a new child that reuses its ID. Pending replies from a removed endpoint are completed with the existing lifecycle error behavior.
- Session shutdown stops new operations, soft-shuts child sessions, closes the router, releases session subscriptions, and disposes the registry only from its root owner.
- Notification batching, steer-delivery behavior, `await_agents`’s completion/message interrupt semantics, abort deferral, error/dead states, channel topology rules, and model inheritance remain unchanged.

### Decision Record Alignment

This architecture follows DR-044 (per-root registry and parent-local routers), DR-021/DR-022 (one dynamically changing group and asymmetric channel additions), DR-019/DR-020/DR-025/DR-047 (notification and wait behavior), DR-046 (error/dead lifecycle), and DR-045 (in-memory tree-scoped quota bypass). It supersedes none of them.
