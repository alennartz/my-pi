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

Dependencies: pi SDK session/runtime factories, the scoped subagents extension factory, the child project-trust resolver, existing agent specifications, and shared auth/model infrastructure from the parent context.

#### Child Project Trust

A local, transport-free module resolves trust for child project resources. It uses only public pi SDK event types and `ProjectTrustStore`; it does not import pi's private CLI trust resolver.

It owns the precedence required for child resource loading: a decisive extension `project_trust` result, then saved trust, then the configured `always`/`never` default, then an unresolved `ask` declining through the supplied headless context. An `undecided` extension result falls through to saved trust. This is a narrow domain seam used by Managed Child Session's resource-loader callback, not a second session backend.

Dependencies: public `LoadExtensionsResult`, `ProjectTrustContext`, `DefaultProjectTrust`, and `ProjectTrustStore` types from pi.

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
- `scope.identity.tools` is the persona-derived policy for Subagents extension tools. `ChildSessionConfig.allowedTools` is the independent SDK-wide child-tool allowlist corresponding to the legacy CLI `--tools` policy. When both apply, effective tool availability is their intersection. The scoped factory always registers `respond` despite the persona policy, but an explicit SDK-wide allowlist may still exclude it.
- The child uplink represents only the parent manager's namespace. A child manager creates a separate local router for its own immediate children.
- Tool routing preserves the current rule: a target owned by the local manager uses the local port; otherwise a child uses its uplink; a root with no local target reports that no agent is available.
- `list_models` remains a session-local extension tool and renders the complete catalog from that scoped session's `ctx.modelRegistry`, including context and pricing, exactly as it does today.
- Session shutdown detaches the scoped extension from its uplink and softly shuts down its immediate children. It does not tear down its parent-owned runtime or mutate the parent's lifecycle record.

The child resource loader removes the normally discovered root-scoped Subagents extension by resolved extension identity, then injects exactly one child-scoped factory. Every other eligible extension remains discoverable under the child's cwd and trust policy.

#### Child project trust

```ts
type ChildProjectTrustOptions = {
  cwd: string;
  extensionsResult: LoadExtensionsResult;
  trustStore: Pick<ProjectTrustStore, "get" | "set">;
  defaultProjectTrust?: DefaultProjectTrust;
  projectTrustContext: ProjectTrustContext;
};

function resolveChildProjectTrust(
  options: ChildProjectTrustOptions,
): Promise<boolean>;
```

Contracts:

- It invokes project extensions with `{ type: "project_trust", cwd }` through the supplied context. The first `yes` or `no` result wins; `undecided` continues precedence resolution.
- If no extension decides, saved trust wins over the configured default. `always` resolves true, `never` resolves false, and `ask` resolves false when the supplied context has no UI without calling its dialog methods.

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
- Project resources follow the CLI's non-interactive trust semantics through `resolveChildProjectTrust`: decisive extension trust, saved trust, and configured defaults are honored in precedence order, but an unresolved `ask` decision does not prompt from a child. The managed module does not import pi's private CLI resolver.
- A model reference is resolved with pi's CLI-compatible model resolver, including thinking suffixes. When no override exists, normal session restoration/settings selection applies. Persona-pinned model precedence remains unchanged.
- Persona skill restrictions use `noSkills` plus explicit absolute skill paths. Forks receive their captured active built-in tools and skill paths. Other cwd-eligible resources continue through `DefaultResourceLoader`.
- The SDK-wide `allowedTools` policy is passed as the session tool allowlist; `ask_user` is excluded from every child. This remains independent from the scoped Subagents extension-tool policy carried by `scope.identity.tools`.
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
- For blocking sends, the response promise, correlation record, target mapping, and deadlock edge are installed before target delivery, so an immediate response cannot race registration. The router allocates a correlation ID when the caller omits one and rejects a caller-supplied ID that is already pending.
- A deadlock cycle rejects the send without delivery.
- Only the endpoint that received a blocking message may `respond()`. A valid response resolves the original sender's response promise, removes the correlation and deadlock edge, and ends its waiting status.
- `cancel()` removes both correlation and edge. `detach()` removes the edge and waiting status but retains the correlation so a late response can be delivered asynchronously by the scoped extension. After delivery has been accepted, cancellation and lifecycle failures resolve the response promise as `{ type: "error", error }`; they do not reject it.
- When a target becomes idle without responding, is removed, or its runtime becomes unavailable, all sends waiting on that target receive the same synthetic failures as today. An idle or failed run leaves the endpoint reusable; removal or an unavailable runtime tombstones it until a replacement endpoint reconnects. Removing a sender also clears correlations it owns.
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

## Tests

**Pre-test-write commit:** `7aec0c2bcaaf977d6f6e5aa5f68ef60bc2757b2b`

**Reopened test-write commit:** `0e0854d371fe5927e9efa289d7ee39f290b7bd67`

### Interface Files

- `extensions/subagents/scoped-extension.ts` — scoped root/child identity contract and extension factory boundary.
- `extensions/subagents/managed-child-session.ts` — SDK-native child target, configuration, lifecycle hooks, and managed runtime contract.
- `extensions/subagents/project-trust.ts` — public-SDK child project-trust precedence contract.
- `extensions/subagents/message-router.ts` — typed in-memory message ports, routed messages/responses, correlation receipts, and router lifecycle contract.

### Test Files

- `extensions/subagents/scoped-extension.test.ts` — exact root/child registration, persona tool restrictions, infrastructure `respond`, and scope isolation.
- `extensions/subagents/scoped-extension.integration.test.ts` — explicit child-uplink routing, scoped model catalog/shutdown behavior, and root orchestration through mocked SDK-native children without RPC or socket brokers.
- `extensions/subagents/managed-child-session.test.ts` — deterministic mocked-SDK construction, target translation, configuration propagation, headless local project-trust wiring, prompt preflight, event/UI hooks, replacement, cooperative abort, and idempotent disposal.
- `extensions/subagents/project-trust.test.ts` — extension, saved, default, and non-interactive `ask` trust precedence using public SDK types.
- `extensions/subagents/managed-child-session.integration.test.ts` — isolated real-SDK reopening of a persisted RPC-era JSONL child session.
- `extensions/subagents/message-router.test.ts` — bidirectional endpoint delivery, correlation allocation/ownership, deadlock and pre-delivery failures, typed terminal failures, dynamic reconnection, blocking-status callbacks, and router shutdown.

### Behaviors Covered

#### Scoped extension construction

- A root-scoped factory exposes exactly the existing subagent tool surface without consulting process-wide parent identity.
- A child-scoped factory applies the persona-derived Subagents tool policy while always registering `respond` for infrastructure responses; the SDK-wide allowlist remains a separate policy.
- Independently constructed scopes keep registrations and mutable state isolated.
- A child routes sends, responses, and incoming notifications through its explicit uplink, keeps notifications detached after session shutdown, and renders `list_models` from its own registry.
- Root orchestration owns mocked SDK-native children rather than RPC children or socket brokers, projects lifecycle events only at `agent_settled`, updates status/dashboard output, persists replacement metadata, supports dynamic membership, interrupts cooperatively, settles pre-start headless errors, restores torn-down sessions, and propagates persona model/tool/skill/cwd policy.

#### Managed child session

- New, resumed, and forked targets map exactly to `SessionManager.create`, `open`, and `forkFrom`, preserve effective cwd/session metadata, and name each child after its agent ID.
- Child creation shares auth/model infrastructure while applying model/thinking, SDK-wide tools, no-direct-user-prompt, explicit skills, append prompt, scoped extension/resource-loader configuration, and the local headless project-trust resolver.
- Prompt submission forwards RPC source and streaming behavior, settles at preflight, surfaces preflight rejection, and observes later run failures.
- Event subscriptions precede headless extension binding; events, UI notifications, shutdown requests, and replacement metadata reach the manager hooks.
- Disposal runs safely more than once, interruption uses cooperative cancellation, and runtime replacement rebinds the same wrapper with current runtime/session/event bus.
- An isolated real SDK test reopens an RPC-era persisted JSONL directly, retaining its session file, ID, cwd, and header.

#### Child project trust

- The local resolver accepts public SDK trust inputs and passes the managed child's headless `rpc` context through resource loading.
- A decisive extension `project_trust` result wins; an `undecided` result falls through to saved trust, then both configured defaults, then a headless unresolved `ask` decline without dialog calls.

#### In-memory message routing

- Connected endpoints deliver fire-and-forget messages in both parent→child and child→parent directions, with unsubscribe support.
- Blocking sends register correlations before delivery, allocate omitted IDs, reject duplicates/pre-delivery failures/deadlocks, and accept responses only from the addressed endpoint.
- Cancel, idle, unavailable, and removal resolve accepted waits as typed errors; detach removes only the waiting edge so reverse work and a late response still arrive.
- Multiple outstanding waits preserve their deadlock edge until all are settled. Idle endpoints remain reusable; unavailable/removed endpoints reject future sends until a replacement reconnects; removal also clears sender-owned waits.
- Blocking-status callbacks fire once at start and once at every terminal path. Router shutdown alone rejects unresolved waits and future sends.

**Review status:** approved
