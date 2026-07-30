# DR-045: In-memory agent-tree-scoped quota bypass

## Status
Accepted

## Context

Quota bypass must propagate from a root agent to its in-process subagents, but it must not leak between unrelated sessions hosted by the same Node process. The previous design carried a root scope id in `PI_QUOTA_SCOPE` and persisted mutable bypass state in a shared `bypass.json`. That model assumed one root per process: in a multi-session host such as Pimote, the first root initialized the process environment and every later root accidentally reused its scope. Persistence also allowed a restart to resurrect a bypass state that was intended to be temporary.

Supersedes DR-042 (Quota bypass state lives in a shared file keyed by scope-id, not in the environment), deleted at commit `4a9209ae6d8119848f5e2d8242e4bff7e97bedd1`.

## Decision

Make the existing `AgentSessionRegistry` own one in-memory key/value store per agent tree. A lightweight shared interface in `lib/session-tree-store.ts` is the only contract other extensions need. The subagents runtime associates each SDK `SessionManager` with its tree store before the session's extensions receive `session_start`; independent roots in the same process therefore get different stores, while descendants retrieve the parent tree's store.

Quota providers use one tree-store key, `quota-providers.bypass`, whose value is a boolean. An absent key means bypass is disabled; turning bypass off deletes the key. The store is read at each prompt so a parent toggle reaches already-running descendants without IPC. The store is cleared when the root tree shuts down, and nothing is persisted.

## Consequences

Bypass is isolated to one live agent tree, including in-process subagents, and cannot survive a process restart. The provider usage snapshot and spend ledger remain shared at provider scope; only the bypass decision is tree-scoped. Other extensions can use the same scoped store without depending on quota-specific code. Cross-process hosts do not coordinate bypass state, which is intentional; they still share provider usage files and ledger locks where configured to do so.
