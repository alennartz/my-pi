# DR-042: Quota bypass state lives in a shared file keyed by scope-id, not in the environment

## Status
Accepted

## Context
Quota bypass needs to propagate to already-running subagent children. Children inherit the parent's `process.env` at spawn time, so env-var-carried state is a spawn-time snapshot that cannot be updated without respawning — a "respawn to recover" wrinkle judged as bad UX. Machine-wide bypass (a single global flag) was also rejected as too coarse: it would disable enforcement across unrelated sessions.

## Decision
Only an immutable scope id (`PI_QUOTA_SCOPE`, set to the root session id, inherited by children at spawn) travels via environment variable. Bypass state itself lives in `bypass.json` under the shared agent cache directory, keyed by scope id. Every pi process reads the file at prompt time — toggling bypass in the parent reaches already-running children at their next prompt without IPC or respawning.

## Consequences
Bypass toggle latency is one prompt boundary, not instantaneous. Stale bypass entries accumulate in the file and are pruned at write time against the current quota window length. Shared-file read at every prompt adds a small I/O cost, bounded and consistent with the existing token/usage cache discipline.
