# DR-044: In-Process Child Sessions with Parent-Local Routing

## Status
Accepted

## Context
The previous subagent design split lifecycle over pi RPC and peer messaging over a Unix-socket broker. That separation supplied process isolation, but it also hid the SDK runtime behind a transport boundary and made session replacement, scoped extension lifecycle, and recursive runtime ownership harder to support. The replacement must preserve parent-local channel, correlation, deadlock, persistence, and completion semantics without retaining a lowest-common-denominator RPC adapter.

Supersedes DR-014 (Dual-Transport Architecture — RPC for Lifecycle, Unix Socket for Messaging), deleted at commit `68e1ef683ceda6fdae65df3b8766ee38c3c8a331`.

## Decision
Run child agents as in-process `AgentSessionRuntime` instances. One `AgentSessionRegistry` exists per root session tree and owns descendant runtime lifecycles, canonical segmented paths, immutable operational snapshots, and presentation attachment; the externally hosted root is represented but never disposed by the registry. Each parent manager retains its own in-memory message router for endpoint authorization, channel enforcement, correlations, blocking-send deadlock detection, and lifecycle failures. A recursive child receives the shared registry, its canonical path, and an explicit uplink, then owns a separate router for its own children.

The scoped extension factory supplies identity and communication explicitly rather than through process environment variables. Every child runtime gets fresh cwd-bound settings, resources, event bus, tools, skills, trust state, extension instances, and an SDK-created `ModelRuntime`. Children share persisted Pi configuration and credentials through the standard file-backed stores, not a parent in-memory auth store or model registry. Existing child JSONL sessions and version-1 lifecycle logs remain the persistence boundary, while the live registry is intentionally not persisted. The subprocess, RPC, and Unix-socket transports are removed rather than kept as a fallback.

This rejects manager-owned runtimes (which would require another ownership refactor for descendant and presentation features), a process-global registry (which would mix unrelated root trees), and a root-wide router (which would change the established parent-local topology and persistence semantics).

## Consequences
The extension can use SDK-native session replacement, cooperative cancellation, runtime disposal, and future presentation adapters while retaining the existing user-facing orchestration model and legacy session compatibility. Explicit scoped construction also prevents concurrent in-process sessions from sharing mutable identity or cwd-bound extension state.

Process isolation guarantees are deliberately relinquished: a child cannot be SIGKILLed independently, does not have an independent process environment or true process cwd, and a runtime failure occurs in the parent process. Cancellation and shutdown therefore rely on cooperative SDK APIs, and registry creation/removal requires careful atomicity and idempotent disposal. The registry holds only live state; historical usage and restoration continue to come from lifecycle records and child session files rather than a global in-memory ledger.
