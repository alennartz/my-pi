# Plan: In-process subagents

## Context

Replace subprocess/RPC-backed subagents with in-process pi SDK sessions while preserving observable behavior and compatibility with existing child sessions and lifecycle logs. The runtime ownership shape deliberately supports later recursive reporting and session presentation, but those product features remain out of scope. See [the brainstorm](../brainstorms/in-process-subagents.md), including its appended architecture clarification.

## Architecture

### Impacted Modules

#### Subagents

The Subagents module keeps its public tool interface and parent-local orchestration semantics. Agent discovery, personas, model tiers, topology, channel enforcement, deadlock policy, notifications, persistence, completion policy, resurrection, status formatting, and dashboard/panel projection remain its responsibilities.

Runtime ownership changes:

- One live `AgentSessionRegistry` exists per root session tree. It contains an externally owned root node and every live descendant node.
- The registry owns descendant `AgentSessionRuntime` creation, replacement, metadata, operational snapshots, and disposal.
- Each `SubagentManager` still manages only its immediate children. It owns their router namespace and persistence records, but reads and updates their canonical node state through the shared registry.
- Every parent retains a separate in-memory router. A recursive child receives the shared registry, its canonical path, and an explicit uplink to its parent's router.
- Child identity and capabilities are supplied through a scoped extension factory rather than process environment variables.
- SDK session events replace RPC events and process-exit polling. Cooperative cancellation replaces signals and hard kill.
- Existing child JSONL sessions and version-1 lifecycle logs remain authoritative for restore and resurrection. The registry itself is not persisted.

The registry does not expose new LLM tools or implement recursive cost aggregation, descendant queries, session navigation, Pimote integration, TUI viewing, or historical reporting.

#### Numbered Select

Numbered Select no longer infers child role from `PI_PARENT_LINK`. It registers `ask_user` normally in root sessions. The normalized child SDK tool policy centrally excludes `ask_user`, so no child can prompt the user directly.

### New Modules

#### Agent Session Registry

A deep module inside `extensions/subagents/` owns the live root-relative tree and all descendant SDK sessions. It validates canonical paths, provides atomic child creation, stores immutable operational snapshots, publishes node lifecycle events, exposes presentation attachment, and disposes registry-owned subtrees.

The registry does not own message topology, lifecycle logs, persona discovery, LLM-facing reports, or historical usage. Those remain parent-manager responsibilities or future projections.

Dependencies: Managed Child Session, shared root auth/model infrastructure, and path/status value types.

#### Managed Child Session

A concrete SDK-native module owns one descendant's `AgentSessionRuntime` and independently scoped services. It hides session target translation, cwd-bound settings/resources, model resolution, tool/skill policy application, extension loading, project trust, SDK event binding, prompt submission, session replacement rebinding, cooperative abort, and idempotent disposal.

It is not an RPC-compatible adapter. The registry node exposes the concrete managed session and underlying runtime so later SDK-native integrations are not constrained by the removed transport.

#### Delegating Extension UI

A small stateful module implements one stable `ExtensionUIContext`. Extensions bind to it once. It forwards to a headless target by default and can temporarily attach another presentation target without rebinding extensions or emitting another `session_start`.

This is an attachment seam only. It contains no Pimote-specific imports or navigation behavior.

#### Child Project Trust

A pure module reproduces pi's non-interactive project-trust precedence using public SDK types: decisive extension result, saved trust, configured default, then headless decline for unresolved `ask`.

#### In-Memory Message Router

A transport-free parent-local router replaces the Unix-socket broker and clients. It owns endpoints, topology authorization, correlations, blocking response lifetimes, detach/cancel behavior, deadlock edges, and lifecycle failures. It has no dependency on SDK sessions or the registry.

### Interfaces

#### Canonical agent paths

```ts
type AgentPath = readonly string[];

function childAgentPath(parent: AgentPath, localId: string): AgentPath;
function formatAgentPath(path: AgentPath): string;
```

Contracts:

- The root path is `[]`.
- A descendant path is its ordered sequence of sibling-scoped agent IDs, for example `["researcher", "scout"]`.
- Internal identity uses segments, never a delimiter-joined string. Existing agent IDs are not newly restricted because they contain `/` or another display delimiter.
- `formatAgentPath()` escapes individual segments before joining them for display and initial pi session naming.
- Duplicate local IDs under one live parent are rejected. The same local ID under different parents is valid.
- Paths are stable for the live logical node even if its current pi session changes. Once a node is removed, its path may be reused.

#### Registry nodes and snapshots

```ts
type NodeOwnership = "external" | "registry";

type AgentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
};

type AgentOperationalSnapshot = {
  state: "running" | "idle" | "waiting" | "failed";
  usage: AgentUsage;
  model?: string;
  lastActivity?: string;
  lastOutput?: string;
  lastError?: string;
  lastTurnInput: number;
  contextWindow?: number;
  hasSubgroup: boolean;
  pendingCorrelations: string[];
  waitingFor: string[];
};

type AgentNodeSnapshot = {
  path: AgentPath;
  parentPath: AgentPath | null;
  localId: string | null;
  ownership: NodeOwnership;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  task?: string;
  agentDef?: string;
  channels: string[];
  operational: AgentOperationalSnapshot;
};

type RegistryEvent =
  | { type: "node_added"; node: AgentNodeSnapshot }
  | {
      type: "node_updated";
      previous: AgentNodeSnapshot;
      node: AgentNodeSnapshot;
    }
  | { type: "node_removed"; node: AgentNodeSnapshot };
```

Contracts:

- Snapshots are immutable values. Managers compute transitions and replace snapshots through registry operations; they do not maintain a second canonical status object.
- The root node has path `[]`, `parentPath: null`, `localId: null`, and `ownership: "external"`. The registry records its metadata and status but never disposes its runtime.
- Descendants have `ownership: "registry"` and a managed SDK session.
- Session metadata updates in place when a logical node switches pi sessions; path and parentage do not change.
- The registry contains active nodes only. `node_removed` carries the final snapshot before deletion; no tombstone or historical cost ledger remains in the registry.

#### Agent session registry

```ts
type ExternalRootNode = {
  get snapshot(): AgentNodeSnapshot & { ownership: "external" };
};

type RegisteredAgentNode = {
  get snapshot(): AgentNodeSnapshot & { ownership: "registry" };
  readonly session: ManagedChildSession;
  readonly presentation: DelegatingExtensionUI;
};

type AgentRegistryNode = ExternalRootNode | RegisteredAgentNode;

type CreateAgentNodeRequest = {
  localId: string;
  task: string;
  agentDef?: string;
  channels: string[];
  session: Omit<ChildSessionConfig, "path" | "scope"> & {
    uplink: MessagePort;
  };
  hooks: ChildSessionHooks;
  initialOperational: AgentOperationalSnapshot;
};

class AgentSessionRegistry {
  constructor(options: {
    root: AgentNodeSnapshot;
    dependencies: ManagedChildSessionDependencies;
    createSession?: typeof createManagedChildSession;
  });

  get(path: AgentPath): AgentRegistryNode | undefined;
  getSnapshot(path: AgentPath): AgentNodeSnapshot | undefined;
  listChildren(parent: AgentPath): AgentNodeSnapshot[];

  createChildren(
    parent: AgentPath,
    requests: CreateAgentNodeRequest[],
  ): Promise<RegisteredAgentNode[]>;

  updateOperational(
    path: AgentPath,
    next: AgentOperationalSnapshot,
  ): void;

  remove(path: AgentPath): Promise<void>;
  attachPresentation(
    path: AgentPath,
    target: ExtensionUIContext,
  ): () => void;
  subscribe(listener: (event: RegistryEvent) => void): () => void;
  dispose(): Promise<void>;
}
```

Contracts:

- Construction requires exactly one external root snapshot at `[]`.
- `createChildren()` requires a live parent, rejects duplicate sibling IDs and reserved `parent`, and reserves every requested path before starting SDK construction.
- Batch creation is atomic. If any session fails, every staged session is disposed, every path reservation is released, no node events survive, and the manager writes no lifecycle records.
- The registry derives each child path, full display/session name, child scope, and shared registry reference. Callers cannot register arbitrary parentage after session creation.
- The parent manager supplies `ChildSessionHooks` for the deterministic child path. The registry decorates `onSessionChanged` so node session metadata is updated before forwarding the callback, while SDK events, UI notifications, and shutdown requests continue to flow to the owning manager. Lifecycle/status policy does not move into the registry.
- Successful creation publishes immutable `node_added` snapshots only after all sessions expose real session IDs/files.
- `updateOperational()` is the single status mutation point and emits `node_updated` only for an actual value change.
- Managed session replacement updates session ID/file/cwd on the existing node and emits `node_updated` without changing its path.
- `remove()` disposes registry-owned descendants and the target safely and idempotently, emits bottom-up final `node_removed` events, and makes paths reusable. Removing `[]` is invalid.
- Presentation attachment is valid only for registry-owned descendants; the external root remains presented by its host.
- `dispose()` removes every registry-owned node and leaves the external root runtime untouched.
- Subscriber failures do not interrupt registry lifecycle operations.
- The registry has no disk I/O. Parent managers continue to decide whether a removal is user teardown or soft shutdown and update lifecycle logs accordingly.

#### Scoped extension construction

```ts
type SubagentScope =
  | { kind: "root" }
  | {
      kind: "child";
      registry: AgentSessionRegistry;
      path: AgentPath;
      identity: {
        id: string;
        task: string;
        channels: string[];
      };
      uplink: MessagePort;
    };

function createSubagentsExtension(scope: SubagentScope): ExtensionFactory;
```

Contracts:

- The default package entrypoint constructs a root-scoped factory. The root factory creates one registry when its root session context is available and registers the external root node.
- A child-scoped factory receives the existing per-root registry and its already-reserved canonical path. It never discovers role or parent identity from process globals.
- Every factory invocation owns isolated mutable extension state: manager, queues, displays, correlation origins, tier notices, and skill-path cache.
- Root and child factories register the same Subagents tool definitions. The session's normalized SDK allowlist determines which tools are active; the factory does not apply a second persona filter.
- Each child manager uses `scope.path` as its owner path, `scope.registry` for runtime/state ownership, and `scope.uplink` for parent/sibling communication.
- Root sessions may restore immediate children and render dashboard/panel state. Child scopes retain the current behavior of not automatically restoring grandchildren after their own restart.
- `list_models` reads the executing session's model registry.
- Session shutdown detaches uplink listeners and softly shuts down the scope's immediate-child manager. The registry remains the only owner allowed to dispose the scope's own runtime.

#### Normalized child tool policy

```ts
type ChildToolPolicyInput =
  | { kind: "default" }
  | { kind: "persona"; tools: string[] }
  | { kind: "fork"; parentActiveTools: string[] };

type ChildToolPolicy =
  | { allowedTools: undefined; excludeTools: ["ask_user"] }
  | { allowedTools: string[]; excludeTools: undefined };

function resolveChildToolPolicy(input: ChildToolPolicyInput): ChildToolPolicy;
```

Contracts:

- A default agent has no SDK allowlist and explicitly excludes `ask_user`.
- Persona tools are the authoritative restriction. The normalized allowlist adds `respond`, removes `ask_user`, and preserves every other named built-in or extension tool.
- Forks inherit the parent's complete active tool names, not only built-ins; normalization adds `respond` and removes `ask_user`.
- Output is deduplicated and deterministic.
- There is no independent `scope.identity.tools` registration policy. This intentionally fixes the current double-filter bug where CLI `--tools` filters a tool that the extension registered.
- Typed-agent extension loading is not expanded with a new persona field. Extension enablement continues to come from each child's isolated cwd settings, package discovery, and trust decision.

#### Delegating extension UI

```ts
class DelegatingExtensionUI {
  readonly context: ExtensionUIContext;

  attach(target: ExtensionUIContext): () => void;
  reset(): void;
}
```

Contracts:

- `context` is a stable object for the lifetime of the logical node and forwards every operation/property to the current target.
- The initial target is a headless implementation: notifications reach child lifecycle hooks, dialogs return non-interactive fallbacks, and visual operations are local no-ops.
- `attach()` replaces the target without calling `session.bindExtensions()` and returns a token-aware detach function. A stale detach cannot displace a newer attachment.
- `reset()` returns to headless behavior.
- Runtime session replacement binds the new session's extension instances to the same delegating context, so an active presentation may survive replacement.
- Registry discovery and any Pimote-specific adapter are deliberately deferred. Nothing in this module imports Pimote.

#### Managed child session

```ts
type ChildSessionTarget =
  | { kind: "new"; cwd: string; sessionDir: string }
  | { kind: "resume"; sessionFile: string; sessionDir: string }
  | {
      kind: "fork";
      sourceSessionFile: string;
      cwd: string;
      sessionDir: string;
    };

type ChildSessionConfig = {
  path: AgentPath;
  target: ChildSessionTarget;
  scope: Extract<SubagentScope, { kind: "child" }>;
  modelRef?: string;
  thinkingLevel?: ThinkingLevel;
  toolPolicy: ChildToolPolicy;
  skillPaths: string[];
  appendSystemPrompt: string[];
};

type ChildSessionHooks = {
  onEvent(event: AgentSessionEvent): void;
  onUiNotify(message: string, type?: "info" | "warning" | "error"): void;
  onSessionChanged(metadata: {
    sessionId: string;
    sessionFile?: string;
    cwd: string;
  }): void;
  onShutdownRequested(): void;
};

class ManagedChildSession {
  readonly runtime: AgentSessionRuntime;
  readonly presentation: DelegatingExtensionUI;
  get eventBus(): EventBusController;
  get session(): AgentSession;
  get sessionId(): string;
  get sessionFile(): string | undefined;

  submit(
    text: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
```

Construction and lifecycle contracts:

- `new`, `resume`, and concurrent child `fork` map to `SessionManager.create`, `SessionManager.open`, and `SessionManager.forkFrom`. Existing RPC-created session files open directly.
- Every active session, including an opened legacy session and any replacement session, receives the escaped full registry path as its initial pi session name. Registry path remains authoritative if an extension later renames the pi session.
- Auth storage and the model registry come from the root registry. Every runtime generation creates its own cwd-bound `SettingsManager`, resource loader, EventBus, trust context, tools, skills, context, and extension instances.
- Model references use pi's CLI-compatible resolver. Persona model precedence and fork thinking inheritance remain unchanged.
- Tool policy is applied exactly once through SDK `tools` or `excludeTools` options.
- Explicit persona skills use `noSkills` plus absolute skill paths. Otherwise normal isolated skill discovery applies.
- `DefaultResourceLoader` retains normal child cwd/package discovery. It filters only the normally discovered root Subagents extension and injects exactly one child-scoped factory carrying registry/path/uplink identity.
- Project trust uses `resolveChildProjectTrust()` with CLI-equivalent non-interactive precedence.
- SDK event subscription occurs before `bindExtensions()` so `session_start` work cannot outrun status projection.
- Extensions bind in `rpc` mode to the stable delegating UI context and runtime-backed command actions. No second bind is needed for presentation attachment.
- Session replacement re-creates scoped services, re-subscribes, binds the new extension instances to the same presentation delegate, and reports metadata without replacing the registry node.
- `submit()` returns at prompt preflight while observing the full prompt promise. Input source remains `rpc`.
- DR-041 remains applicable: an input handler may return `handled` with preflight success, so an error notification before `agent_start` settles the child as failed.
- `abort()` uses cooperative SDK cancellation. `dispose()` is idempotent and delegates to `AgentSessionRuntime.dispose()` so extension shutdown runs.

#### Child project trust

```ts
type ChildProjectTrustOptions = {
  cwd: string;
  extensionsResult: LoadExtensionsResult;
  trustStore: Pick<ProjectTrustStore, "get" | "set">;
  defaultProjectTrust?: DefaultProjectTrust;
  projectTrustContext: ProjectTrustContext;
  onExtensionError?: (error: ExtensionError) => void;
};

function resolveChildProjectTrust(
  options: ChildProjectTrustOptions,
): Promise<boolean>;
```

Contracts:

- Project extension handlers run in loader order. The first `yes` or `no` wins; `undecided` falls through.
- A remembered extension decision is saved. Handler failures are reported through `onExtensionError` and are non-decisive.
- Saved trust wins over configured `always`/`never`; unresolved `ask` returns false without invoking child dialog UI.

#### In-memory routing

```ts
type RoutedMessage = {
  from: string;
  message: string;
  correlationId?: string;
  responseExpected: boolean;
};

type RoutedResponse =
  | { type: "response"; message: string }
  | { type: "error"; error: string };

type SendReceipt = {
  correlationId?: string;
  response?: Promise<RoutedResponse>;
};

interface MessagePort {
  readonly id: string;
  send(input: {
    to: string;
    message: string;
    expectResponse: boolean;
    correlationId?: string;
  }): Promise<SendReceipt>;
  respond(correlationId: string, message: string): Promise<void>;
  detach(correlationId: string): void;
  cancel(correlationId: string): void;
  subscribe(listener: (message: RoutedMessage) => void): () => void;
}
```

Routing remains parent-local:

- Each manager owns one router namespace with reserved endpoint `parent` and immediate-child endpoints.
- Child scopes use their explicit uplink for parent/sibling targets and create a separate router for their own children.
- Channel checks, target availability, correlation registration-before-delivery, deadlock detection, responder ownership, detach/cancel, idle failures, reconnect, and quiet-state semantics remain as reviewed.
- Accepted lifecycle/cancel failures resolve as typed error responses. Router shutdown rejects unresolved waits.
- Registry paths do not change the LLM-facing local IDs or channel vocabulary.

#### Manager and registry state projection

A manager entry retains only orchestration/persistence data not owned by the registry: child path, persona record, task/channels, fork restoration metadata, router port, completion-notified flag, and prompt-start tracking.

Contracts:

- Manager status getters read canonical immediate-child snapshots through `registry.listChildren(ownerPath)`.
- For every child request, the manager constructs path-bound `ChildSessionHooks` before registry creation. SDK event hooks calculate the same activity, usage, model, context, subgroup, waiting, output, and failure transitions as today, then call `registry.updateOperational()`.
- `agent_start` marks running. Terminal `agent_end` records a final assistant error, while `agent_settled` is the single completion boundary after retries, compaction, and continuations.
- Headless pre-start error notification follows DR-041. Runtime unavailability produces failed state without process stderr or exit polling.
- Existing `onUpdate` and completion callbacks project registry snapshots into the TUI dashboard, Pimote panel, XML notifications, and tool results.
- `interrupt` resolves a nonfailed node and calls its managed session's cooperative abort. It remains a no-op for a failed node, preserving the current observable tool behavior.
- Manager spawn/fork/resurrect requests registry-owned children atomically, then writes existing persistence records and submits initial tasks. A construction rollback writes nothing.
- User teardown writes `agent_removed` and asks the registry to remove the node subtree. Soft shutdown asks the registry to dispose live children without writing removals. Registry disposal is idempotent when nested `session_shutdown` handlers converge.
- Completion requires every immediate child snapshot to be idle/failed and the local router to be quiet.

#### Persistence compatibility

`PersistencePaths`, `PersistedAgentRecord`, and version-1 lifecycle event shapes remain compatible.

- Fresh child sessions remain under `<parent-session>.subagents/sessions`.
- Records continue using sibling-local agent IDs. Registry paths are deterministically reconstructed from the restoring manager's owner path plus each record ID; no registry ID or tree file is persisted.
- Restore still prunes invalid cwd values, recomputes usage/model/output from child JSONL, re-resolves personas for capabilities, and opens the recorded session.
- Resurrection still finds removed records through transcript-provided session IDs.
- A session replacement may append another `agent_added` event for the same local ID with updated session metadata using the existing schema.
- Child-scoped startup retains the current limitation of not automatically reconstructing grandchildren.

### Technology Choices

#### Per-root registry over manager-owned sessions

Choose one live registry per root tree. It owns runtime lifecycle, canonical paths, tree shape, snapshots, and presentation attachment; managers retain parent-local orchestration.

Rejected alternatives:

- Direct manager ownership would require another ownership refactor for known descendant and presentation features.
- A process-global registry would mix unrelated roots and introduce global lifecycle state.
- Moving topology and persistence into the registry would change current semantics and over-expand the module.

#### Pi SDK runtime over subprocess RPC

Use `createAgentSessionServices`, `createAgentSessionFromServices`, and `createAgentSessionRuntime`. `AgentSessionRuntime` is required for scoped service recreation, extension shutdown, and future session replacement.

Rejected alternatives:

- Retaining RPC as a fallback would force a lowest-common-denominator interface.
- Bare `AgentSession` would push replacement and shutdown behavior into callers.

#### Isolated default resource discovery

Use a fresh `DefaultResourceLoader` per child runtime generation. Filter only the root Subagents extension and inject the child-scoped factory. Share auth/model infrastructure but not settings, loaders, EventBuses, or extension instances.

Rejected alternatives:

- `noExtensions` plus manual reconstruction would diverge from normal cwd/package discovery.
- Shared resource loaders or extension runtimes would violate RPC-equivalent session isolation.

#### Parent-local typed router

Use direct ports/promises behind one router per manager. A root-wide router is unnecessary because global tree inspection belongs to the registry, while messaging IDs and channel rules remain sibling-local.

#### Stable delegating UI context

Bind child extensions once to a delegating context rather than rebinding the SDK session when a future presentation attaches. This avoids duplicate `session_start` side effects while remaining presentation-agnostic.

#### Deferred Pimote discovery

Do not add factory injection, EventBus object discovery, global registries, or Pimote imports in this change. The registry's neutral lookup, event, and presentation interfaces preserve options for a later generic adapter without coupling repositories prematurely.

No new dependency is introduced.

### DR Supersessions

- **DR-014** (Dual-Transport Architecture — RPC for Lifecycle, Unix Socket for Messaging) — superseded because child lifecycle and communication now occur within one process. New decision: a per-root registry owns SDK child sessions, while parent-local in-memory routers retain centralized channel and deadlock authority. Process-isolation guarantees are deliberately relinquished.

## Tests

**Pre-test-write commit:** `330932b7e65a8dfc9e51771aa31fec80934b0e99`

### Interface Files

- `extensions/subagents/agent-path.ts` — canonical segmented agent paths and escaped display/session names.
- `extensions/subagents/agent-session-registry.ts` — per-root node, snapshot, event, atomic creation/removal, and presentation-attachment contracts.
- `extensions/subagents/child-tool-policy.ts` — normalized single SDK tool-policy input/output contracts.
- `extensions/subagents/delegating-extension-ui.ts` — stable attachable/detachable extension UI context contract.
- `extensions/subagents/managed-child-session.ts` — path-aware child session configuration, normalized tool policy, presentation exposure, and SDK lifecycle contract.
- `extensions/subagents/scoped-extension.ts` — registry/path-aware child scope contract without a second persona tool policy.
- `extensions/subagents/project-trust.ts` — public-SDK child trust options extended with extension-error reporting.
- `extensions/subagents/agent-set.ts` — structural manager options for shared registry and canonical owner path.

### Test Files

- `extensions/subagents/agent-path.test.ts` — root, nested, immutable, and delimiter-safe canonical path behavior.
- `extensions/subagents/agent-session-registry.test.ts` — external root ownership, hierarchy, atomic child creation, canonical snapshots/events, removal, live path reuse, and presentation attachment.
- `extensions/subagents/child-tool-policy.test.ts` — default, persona, and fork normalization into one SDK allowlist.
- `extensions/subagents/delegating-extension-ui.test.ts` — stable headless context, attachment, token-aware detachment, and reset.
- `extensions/subagents/agent-set.test.ts` — revised registry-backed manager status projection and canonical-path interruption behavior, including the failed-node no-op parity rule.
- `extensions/subagents/managed-child-session.test.ts` — revised path/session naming, registry-aware scope, normalized policy, trust wiring, SDK lifecycle, replacement, and cooperative disposal.
- `extensions/subagents/managed-child-session.integration.test.ts` — revised direct reopening of an RPC-era JSONL session with path-aware child configuration.
- `extensions/subagents/scoped-extension.test.ts` — revised registry/path-aware child scope and single-policy tool registration.
- `extensions/subagents/scoped-extension.integration.test.ts` — revised registry-aware orchestration, uplink routing, lifecycle projection, persistence records, dynamic membership, interruption, resurrection, persona model/skills/cwd, and normalized tools.
- `extensions/subagents/message-router.test.ts` — preserved parent-local routing, correlation, deadlock, lifecycle-failure, reconnection, and shutdown behavior.
- `extensions/subagents/project-trust.test.ts` — preserved public-SDK trust precedence and non-interactive fallback behavior.
- `extensions/subagents/persistence.test.ts` and `extensions/subagents/session-snapshot.test.ts` — preserved lifecycle-log and persisted-session compatibility behavior.

### Behaviors Covered

#### Canonical paths and normalized child policy

- The external root uses path `[]`; child paths append sibling-scoped local IDs without mutating parent paths.
- Escaped full-path formatting preserves segment order and prevents delimiter-bearing IDs from colliding with separate segments; the escaped path is the child session naming input.
- Default children use no allowlist while excluding `ask_user`; persona and fork inputs become one deduplicated allowlist that includes `respond`, excludes `ask_user`, and preserves extension tools.

#### Agent session registry

- Construction registers exactly one externally owned root at `[]`; registry disposal leaves that root host-owned.
- Child creation derives canonical paths, rejects duplicate live siblings/reserved parent IDs, allows repeated local IDs under different parents, and passes shared registry/path/uplink context to managed sessions.
- Batch creation reserves paths atomically; any construction failure disposes staged sessions, releases reservations, and publishes no add events.
- Operational snapshots are replaced immutably and publish `node_updated` only for actual changes; session replacement updates metadata without changing path or parentage.
- Removal is idempotent, disposes descendants bottom-up, emits final `node_removed` snapshots, and makes removed paths reusable without tombstones or historical cost.
- Presentation attaches only to registry-owned descendants; subscriber failures do not interrupt lifecycle operations.

#### Delegating extension UI

- A child extension binds once to a stable context that forwards to a headless target initially.
- Attachment switches forwarding without rebinding; stale detach tokens cannot displace newer attachments, and reset returns to headless behavior.

#### Managed child session and scoped extension

- New, resumed, forked, and replacement sessions receive the escaped full canonical path as their session name while retaining path authority and legacy session metadata.
- Each child receives isolated settings/resources/EventBus/extensions/trust context while sharing root auth/model infrastructure; its scope carries the registry, path, identity, and uplink.
- Child SDK tool configuration consumes exactly one normalized policy; scoped extension registration does not apply a second persona filter.
- Existing prompt preflight, event ordering, headless UI, project-trust, cooperative interruption, replacement rebinding, idempotent disposal, and direct persisted-session reopening behavior remain covered.

#### Registry-aware manager and orchestration

- Manager status getters read canonical immediate-child snapshots through the owning registry path rather than manager-local session/status state.
- Manager interruption resolves the canonical node under its owner path and aborts a nonfailed managed session cooperatively; a failed node is a no-op for observable parity.
- Root/child orchestration retains explicit uplink routing, lifecycle completion at `agent_settled`, status/dashboard projection, atomic dynamic membership, persistence replacement records, teardown/resurrection, full-active-tool fork inheritance, persona model/skills/cwd, and normalized tools without RPC or socket ownership.

#### Preserved domain compatibility

- Parent-local router behavior, public-SDK project-trust precedence, version-1 lifecycle logs, cwd/tool/skill compatibility, and persisted JSONL snapshot recomputation remain covered by their reviewed tests.

The reopened suite intentionally adds no Pimote integration, recursive reporting, historical cost retention, or registry persistence tests.

**Review status:** approved
