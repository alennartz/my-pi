# Brainstorm: In-process subagents

## Idea

Replace the subagents extension's spawned pi processes, RPC lifecycle channel, and Unix-socket message transport with in-process pi SDK sessions.

The purpose of this change is architectural: make subagents native SDK sessions while retaining the extension's current observable behavior. Later work may use direct runtime access for recursive cost reporting, cross-session viewing in Pimote, and deeper descendant visibility, but none of those features belong in this change.

## Key Decisions

- **Feature parity is defined at the observable extension boundary.**
  - Preserve the existing tools and their behavior: spawning, forking, messaging, responding, status inspection, teardown, resurrection, waiting, interruption, and model listing.
  - Preserve recursive spawning, dynamic membership, channel enforcement, deadlock detection, completion notifications, status reporting, persona restrictions, model and thinking selection, skills, cwd behavior, and widget/panel output.
  - Preserve persisted child sessions, parent lifecycle logs, restore, fork, teardown/resurrection, and compatibility with bundles created by the RPC implementation.
  - Rationale: this is a runtime migration, not a product redesign.

- **Process-only guarantees are explicitly outside parity.**
  - Do not attempt to preserve process crash containment, SIGTERM/SIGKILL escalation, independent process environments, or a true per-child `process.cwd()`.
  - Cancellation becomes the SDK's cooperative cancellation model.
  - Rationale: these guarantees fundamentally conflict with same-process SDK sessions. Recreating them would undermine the purpose of the migration.

- **Use the SDK directly; do not retain RPC as a second backend.**
  - Remove the subprocess/RPC/socket implementation rather than hiding RPC and SDK behind a lowest-common-denominator child interface.
  - Internal code may expose `AgentSession` and `AgentSessionRuntime` directly where those capabilities are useful.
  - Rationale: the long-term value of the migration is access to capabilities that RPC cannot expose. A compatibility abstraction would preserve the old architecture's limits.

- **Preserve the current parent-local management model.**
  - Each agent continues to manage its immediate children and expose the same immediate-child tool semantics.
  - Do not introduce a root-owned global agent tree, recursive usage aggregation, expanded descendant queries, or new tree persistence in this change.
  - In-process parent/child references and direct runtime handles are acceptable implementation facts, but they are not a new user-facing feature.
  - Rationale: future extensibility should inform seams without pre-implementing future features.

- **Use session-scoped identity instead of process-scoped identity.**
  - Replace `PI_PARENT_LINK` and socket registration with explicit identity and parent linkage supplied when constructing each child session's extension instance.
  - Recursive children receive their own scoped extension instance.
  - Rationale: concurrent in-process sessions cannot safely distinguish roles through mutable process environment variables.

- **Follow the proven multi-session SDK lifecycle pattern used by Pimote.**
  - Construct cwd-bound services per session, use a dedicated event bus and subscriptions per child, share auth/model infrastructure where appropriate, bind extensions explicitly, and dispose runtimes cleanly.
  - Pimote integration itself is out of scope.
  - Rationale: `../pimote` already demonstrates multiple live `AgentSessionRuntime` instances in one process, including event routing, extension binding, session replacement, and cleanup.

## Direction

Refactor the subagents extension around SDK-owned child sessions while keeping its current orchestration domain behavior intact:

- Keep agent discovery, personas, model tiers, topology, deadlock rules, notification batching, persistence semantics, status formatting, and tool contracts.
- Replace CLI argument construction with structured SDK session/resource configuration.
- Replace `RpcChild` and process monitoring with direct `AgentSessionRuntime` ownership, SDK event subscriptions, prompt preflight handling, cooperative abort, and runtime disposal.
- Replace Unix-socket delivery with direct in-memory routing while retaining the current authorization, correlation, blocking-send, and deadlock behavior.
- Refactor the extension factory so each in-process child receives explicit parent identity, tool restrictions, communication scope, and runtime ownership without relying on global environment state.
- Preserve the existing session files and lifecycle-log schema where possible; migration compatibility is part of parity.

Success means the existing subagent workflows behave the same from an agent and user's perspective, existing persisted sessions remain usable, and no child pi processes, RPC streams, or broker sockets remain.

## Open Questions

### Sharp technical questions for architecture

- What is the narrowest session-construction module that can translate current agent/fork specifications into `AgentSessionRuntime`, cwd-bound services, resources, tools, skills, model, thinking level, and persisted-session targets?
- How should automatic discovery of the root subagents extension be filtered and replaced with a child-scoped inline factory without changing other extension discovery behavior?
- Which parts of the current broker should remain as pure routing/deadlock domain logic, and which transport-specific parts should be deleted?
- How can the current persistence schema be reused unchanged while replacing process startup and restore mechanics?
- What headless extension UI binding preserves notifications and prompt-rejection behavior for child sessions?
- Which existing tests can be retained at domain boundaries, and which process/RPC integration tests need SDK-session replacements?

### Fog

- None currently. Process-isolation differences are accepted constraints, not unresolved requirements.

## Architecture Clarification

The interactive architecture retrospective corrected one ownership assumption without changing the brainstorm's product scope:

- Parent-local managers still own immediate-child orchestration, topology, messaging, persistence, completion policy, and the existing tool behavior.
- A live **per-root session registry** owns the root-relative hierarchy, descendant SDK runtimes, and canonical operational snapshots. This is runtime ownership infrastructure, not a new recursive-reporting or navigation feature.
- The externally owned root is represented at path `[]`. Descendant identity is a canonical segmented path of sibling-scoped agent names, such as `["researcher", "scout"]`; paths are live-only and reusable after removal.
- The registry is not persisted. Existing per-parent lifecycle logs remain authoritative, and current nested-restore limitations remain unchanged.
- Removed nodes leave the active registry after emitting a final snapshot. Historical cost retention is a future projection, not registry state.
- Each agent receives an isolated settings manager, resource loader, EventBus, extension instances, tools, skills, context, trust decision, and system prompt. Auth storage and the model registry are shared within the root.
- Each parent retains its own in-memory message router. Recursive children receive an explicit uplink plus the shared registry and their canonical path.
- Child extensions bind once to a stable delegating UI context: headless initially, attachable later without emitting another `session_start`. Pimote discovery and integration remain deliberately unresolved so Pimote does not become coupled to this external extension.
- Child pi session names initialize from the escaped full path. The path remains authoritative if the pi session changes.
- Persona tool restrictions are normalized once as the SDK allowlist. Infrastructure `respond` is always included, direct-user `ask_user` is always excluded, and forks inherit the parent's complete active tool set. This intentionally fixes the current double-filter bug where CLI `--tools` can remove registered extension tools.
- The local child project-trust resolver preserves CLI precedence because pi does not publicly export that resolver.

This clarification supersedes only the brainstorm's assumption that a shared tree would necessarily implement the future features. It does not add recursive cost reporting, descendant-facing tools, session navigation, Pimote integration, a TUI viewer, a historical ledger, or root-wide persistence to the current change.
