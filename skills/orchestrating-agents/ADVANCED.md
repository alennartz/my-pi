# Advanced Agent Modes

Read this reference before using a custom working directory, retaining agents across turns, tearing down or resurrecting agents, or letting a child spawn descendants.

## Per-agent working directories

A `subagent` item can set `cwd`. Resolve a relative value against the parent's cwd. The directory must exist and be a directory. Validation is batch-atomic: one invalid cwd prevents the whole spawn call.

The child starts as if pi launched in that directory. Its `AGENTS.md`, project agents, and project skills come from that working directory. Persist the cwd in the agent record so restore can replay it. If the directory is later deleted, restore prunes the agent instead of failing the whole restore.

`fork` and `resurrect` inherit the stored cwd. They do not accept a cwd override.

## Recursive subagents

Any agent can spawn its own subagents. Use recursion when a worker's task is large enough to need its own decomposition. The parent sees the worker's result, not the worker's internal descendants. Keep the nested topology small and give the worker a complete brief for its own coordination.

## Session lifetime

Child sessions persist per parent session and are reconstructed from append-only lifecycle logs. A child is not a disposable process.

- Use incremental growth when new work appears. Add agents to the running set rather than rebuilding the group.
- Use `teardown` when an agent should leave the active set. Teardown has semantic effect.
- Use `resurrect` to revive a torn-down agent from its persisted session file. Pass the `session_id` from the teardown or completion report.
- Keep persistent specialists alive when more work is expected. Tear them down when the repeated work ends.
