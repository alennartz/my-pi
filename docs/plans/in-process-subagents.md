# Plan: In-process subagents

## Context

Replace subprocess/RPC-backed subagents with in-process pi SDK sessions while preserving the extension's observable behavior and persisted-session compatibility. Process isolation guarantees are deliberately excluded, and later recursive reporting or cross-session UI features remain out of scope. See [the brainstorm](../brainstorms/in-process-subagents.md).

## Architecture

### Impacted Modules

#### Subagents

The Subagents module keeps ownership of the public orchestration interface and its existing parent-local semantics. Agent discovery, personas, model tiers, tool schemas, topology rules, deadlock detection, notification batching, persistence records, status rendering, and lifecycle reports remain its responsibilities.

Its runtime responsibilities change:

- Child execution is owned through live `AgentSessionRuntime` objects rather than `ChildProcess`/RPC handles.
- Each extension instance still manages only its immediate children. A child receives an explicit in-memory uplink to its parent and may create its own local manager for recursive spawning.
- Child identity, tool restrictions, and parent linkage are passed through a scoped extension factory rather than `PI_PARENT_LINK`.
- Lifecycle and usage state are derived from direct `AgentSessionEvent` subscriptions. Process-exit polling and stderr-based failure handling disappear.
- Inter-agent messages use an in-memory router. Channel authorization, correlation ownership, blocking-send behavior, detach/cancel behavior, deadlock detection, and idle/removal failure semantics remain unchanged.
- Existing lifecycle logs and child session files remain the source of truth for restore and resurrection.

The module remains parent-local: it does not add a root registry, recursive aggregation, descendant queries, or cross-session viewing.

#### Numbered Select

Numbered Select no longer infers subagent role from `PI_PARENT_LINK`. Root sessions continue to register `ask_user`; SDK child creation centrally excludes that tool from child sessions, preserving the current no-direct-user-prompt policy without process environment coupling.

### New Modules

#### Managed Child Session

A concrete SDK-native module inside `extensions/subagents/` owns the full lifecycle of one child session. It hides cwd-bound service construction, project-trust resolution, resource loading, model selection, extension binding, event rebinding after session replacement, prompt submission, cooperative interruption, and disposal behind a small interface.

This is not an RPC/SDK compatibility adapter and has no alternate process implementation. It deliberately exposes its `AgentSessionRuntime` so later SDK-native capabilities are not hidden behind the old transport's limits.

Dependencies: pi SDK session/runtime factories, the scoped subagents extension factory, existing agent specifications, and shared auth/model infrastructure from the parent context.

#### In-Memory Message Router

A transport-free routing module replaces the Unix-socket broker and socket clients. It owns the topology, registered endpoints, correlation table, deadlock graph, removed-agent state, and delivery of messages/responses/errors.

The router remains centralized within each parent-local manager, preserving the current hub-and-spoke authority. Its interface deals in typed messages and promises rather than JSONL frames or acknowledgements.

Dependencies: existing channel topology and deadlock modules. It has no dependency on SDK sessions or extension UI.

### Interfaces

#### Scoped extension construction

```ts
type SubagentScope =
  | { kind: "root" }
  | {
      kind: "child";
      identity: {
        id: string;
        task: string;
        channels: string[];
        tools?: string[];
      };
      uplink: MessagePort;
    };

function createSubagentsExtension(scope: SubagentScope): ExtensionFactory;
```

The package entrypoint exports a root-scoped factory as its default. Managed child sessions inject a child-scoped inline factory.

Contracts:

- All mutable extension state remains inside the returned factory closure; no session identity is read from or written to process globals.
- A child scope registers the same tools as today, subject to its persona tool restriction, with `respond` retaining its infrastructure exception.
- The child uplink represents only the parent manager's namespace. A child manager creates a separate local router for its own immediate children.
- Tool routing preserves the current rule: a target owned by the local manager uses the local port; otherwise a child uses its uplink; a root with no local target reports that no agent is available.
- `list_models` remains a session-local extension tool and renders the complete catalog from that scoped session's `ctx.modelRegistry`, including context and pricing, exactly as it does today.
- Session shutdown detaches the scoped extension from its uplink and softly shuts down its immediate children. It does not tear down its parent-owned runtime or mutate the parent's lifecycle record.

The child resource loader removes the normally discovered root-scoped Subagents extension by resolved extension identity, then injects exactly one child-scoped factory. Every other eligible extension remains discoverable under the child's cwd and trust policy.

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
  id: string;
  target: ChildSessionTarget;
  scope: Extract<SubagentScope, { kind: "child" }>;
  modelRef?: string;
  thinkingLevel?: ThinkingLevel;
  allowedTools?: string[];
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

function createManagedChildSession(
  config: ChildSessionConfig,
  dependencies: {
    agentDir: string;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
  },
  hooks: ChildSessionHooks,
): Promise<ManagedChildSession>;
```

Construction contracts:

- `new`, `resume`, and `fork` map to `SessionManager.create`, `SessionManager.open`, and `SessionManager.forkFrom` respectively. Existing RPC-created JSONL sessions are opened directly; no session-format migration is introduced.
- The child session name is the agent ID, matching the current CLI `--name` behavior.
- Auth storage and the model registry are shared with the parent session. Settings, resource loading, tools, and the event bus are created per effective child cwd, following the multi-session pattern already used by Pimote.
- Project resources follow the CLI's non-interactive trust semantics: saved trust and configured defaults are honored, but an unresolved `ask` decision does not prompt from a child.
- A model reference is resolved with pi's CLI-compatible model resolver, including thinking suffixes. When no override exists, normal session restoration/settings selection applies. Persona-pinned model precedence remains unchanged.
- Persona skill restrictions use `noSkills` plus explicit absolute skill paths. Forks receive their captured active built-in tools and skill paths. Other cwd-eligible resources continue through `DefaultResourceLoader`.
- The discovered root Subagents extension is filtered and replaced by the scoped child factory. `ask_user` is excluded from every child. No other extension is removed solely because the session is a child.
- The manager subscribes before `bindExtensions()` so work triggered by `session_start` cannot outrun status tracking.
- Extensions bind in `rpc` mode with a headless UI context, runtime-backed command actions, an abort handler, a child-local shutdown handler, and an extension-error listener.
- Runtime session replacement re-creates cwd-bound services, rebinds extensions and subscriptions, and reports the new session metadata through `onSessionChanged` without replacing the `ManagedChildSession` object.

Prompt and shutdown contracts:

- `submit()` calls `session.prompt()` with input source `rpc` and returns when prompt preflight has accepted or rejected the input; it does not wait for the agent run to settle. The full prompt promise remains observed internally so later rejection cannot become an unhandled promise.
- A thrown preflight failure rejects `submit()`. An input handler that returns `handled` still reports preflight success in pi; DR-041 therefore remains in force through `onUiNotify`: an error notification received before `agent_start` settles the child as failed.
- `abort()` delegates to cooperative SDK cancellation. No hard-kill fallback exists.
- `dispose()` delegates to `AgentSessionRuntime.dispose()` so `session_shutdown` handlers run before resources and subscriptions are released. It is idempotent.

The headless UI context preserves non-interactive child behavior: notifications reach `onUiNotify`; status/widget/title operations do not target the parent's TUI; dialogs resolve to their non-interactive fallback rather than asking the user. Scoped child extensions receive the same context again after a runtime session replacement.

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

class MessageRouter {
  constructor(options: {
    topology: Topology;
    onBlockingSendStart?: (
      from: string,
      to: string,
      correlationId: string,
    ) => void;
    onBlockingSendEnd?: (from: string, correlationId: string) => void;
  });

  connect(agentId: string): MessagePort;
  agentIdle(agentId: string): void;
  agentUnavailable(agentId: string, error: string): void;
  agentRemoved(agentId: string): void;
  isQuiet(): boolean;
  close(): void;
}
```

Routing contracts:

- `parent` remains a reserved endpoint ID. Each local manager connects its own parent endpoint plus one endpoint per immediate child.
- Channel validation occurs before delivery. Dead/removed, disconnected, and unauthorized targets fail without creating a pending correlation.
- For blocking sends, the response promise, correlation record, target mapping, and deadlock edge are installed before target delivery, so an immediate response cannot race registration.
- A deadlock cycle rejects the send without delivery.
- `respond()` resolves the original sender's response promise, removes the correlation and deadlock edge, and ends its waiting status.
- `cancel()` removes both correlation and edge. `detach()` removes the edge and waiting status but retains the correlation so a late response can be delivered asynchronously by the scoped extension.
- When a target becomes idle without responding, is removed, or its runtime becomes unavailable, all sends waiting on that target receive the same synthetic failures as today. An idle or failed run leaves the endpoint reusable; removal or an unavailable runtime tombstones it. Removing a sender also clears correlations it owns.
- `close()` rejects unresolved correlations and drops all endpoint subscriptions without touching persistence or SDK runtimes.

The existing XML message and completion serializers remain unchanged. Socket-only request/response frame types are removed.

#### Subagent manager and status projection

`SubagentManager` retains its tool-facing operations and reports. Each internal entry replaces `RpcChild` with a `ManagedChildSession` and the child's `MessagePort`.

Lifecycle projection contracts:

- `tool_execution_start` updates last activity and subgroup hints.
- Assistant `message_end` accumulates tokens, cost, model, context fill, and last output exactly once.
- `agent_start` marks the entry running and records that the submitted prompt began.
- A terminal `agent_end` (`willRetry === false`) records any final assistant error. Completion is emitted at `agent_settled`, the authoritative boundary after retries, compaction, and queued continuations.
- An error-level headless UI notification before `agent_start` follows DR-041 and settles the entry as failed.
- Runtime creation, binding, or prompt failures settle the affected entry as failed and surface their error; there is no process stderr fallback.
- `interrupt` calls the managed session's cooperative `abort()`.
- User teardown removes the entry from routing before disposal and appends `agent_removed`. Soft shutdown disposes sessions and routing without appending removals, allowing the next root startup to restore them.
- Completion still requires every immediate child to be idle/failed and the local router to have no pending correlations.
- Every status mutation continues through the manager's existing `onUpdate` callback. The scoped extension projects that immediate-child status through the existing TUI dashboard or Pimote panel handle, including initial spawn/restore, activity changes, completion, interruption, and teardown. Arbitrary widgets/statuses emitted by extensions inside a headless child remain headless; they are not the Subagents dashboard contract.

Batch validation remains atomic before session creation. If construction of a batch fails after some sessions were created, those sessions and ports are disposed and no partial `agent_added` records survive.

#### Persistence compatibility

The `PersistencePaths`, `PersistedAgentRecord`, and version-1 lifecycle event shapes remain unchanged.

- Fresh children continue writing sessions beneath `<parent-session>.subagents/sessions`.
- `agent_added` is written only after a child runtime exposes its real session file and ID. If an extension-driven session replacement changes that metadata, another `agent_added` event for the same agent ID records the new live session using the existing schema.
- Restore still prunes invalid persisted cwd overrides independently, recomputes status from the child JSONL, re-resolves personas for tool restrictions, and opens the latest recorded child session.
- Resurrection continues to locate removed records by transcript-provided session ID and reuses the same session file.
- Child-scoped sessions retain the current restore limitation: on their own restart they do not automatically reconstruct grandchildren. Changing recursive restore behavior is outside feature parity.

### Technology Choices

#### Pi SDK runtime instead of subprocess RPC

Use `createAgentSessionServices`, `createAgentSessionFromServices`, and `createAgentSessionRuntime`. `AgentSessionRuntime` is required rather than bare `AgentSession` because child extensions may replace sessions or cwd, and runtime disposal emits the extension shutdown lifecycle.

Rejected alternatives:

- Retaining RPC as a fallback would force a lowest-common-denominator interface and preserve the transport architecture this change removes.
- Bare `AgentSession` would make session replacement, cwd-bound service recreation, and extension shutdown the Subagents module's responsibility.

#### Default resource discovery with a scoped override

Use `DefaultResourceLoader` through `createAgentSessionServices`, filter only the discovered root Subagents extension with `extensionsOverride`, and inject the child-scoped factory with `extensionFactories`.

Rejected alternatives:

- `noExtensions` plus manual reconstruction risks silently diverging from normal cwd/package discovery.
- A fully custom `ResourceLoader` would duplicate pi's trust, package, context, skills, and prompt discovery behavior.

#### Typed in-memory router instead of EventBus messaging

Use a dedicated router with direct ports and promises. The existing per-session EventBus remains for extension communication but does not carry orchestration messages.

Rejected alternatives:

- A shared EventBus does not naturally own channel authorization, blocking response lifetimes, detach/cancel semantics, or deadlock edges.
- Node streams or `MessageChannel` would retain framing and transport machinery without providing process isolation.

No new dependency is introduced.

### DR Supersessions

- **DR-014** (Dual-Transport Architecture — RPC for Lifecycle, Unix Socket for Messaging) — superseded because child lifecycle and communication now occur within one process. New decision: own children as `AgentSessionRuntime` instances and route messages through a centralized in-memory router, while explicitly relinquishing process-isolation guarantees.
