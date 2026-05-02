# Manual Test Plan

Persistent, repo-wide manual test plan. Lists primary user journeys — the
high-value happy paths whose breakage would constitute an unacceptable
regression. Topic-specific edge cases live in `docs/manual-tests/<topic>.md`,
not here.

## What this repo produces

A pi package: TypeScript extensions, Markdown skills, agent definitions,
prompt templates. Users exercise it by running pi with the package
installed/loaded. The extensions are loaded at pi startup and surface tools,
TUI widgets, and lifecycle hooks. The most direct manual driver is therefore
**a live pi process with this package loaded** — invoking the surfaced tools
the way the model would. For this repo, the parent agent inside pi already
has the relevant tool surface (subagent/fork/teardown/resurrect/await/etc.)
and IS the test harness.

## Primary User Journeys

### J1: Subagent lifecycle — spawn, message, teardown

**What:** Spawn one or more child agents via the `subagent` tool, exchange
messages (fire-and-forget and expect-response), tear them down individually
or in bulk via `teardown`. Verify XML completion reports surface in the
parent's transcript with the documented shape.

**Why:** Subagents are the foundation of every workflow phase that delegates
work (architecting, impl-planning, implementing, code-review, autoflow).
Breakage here breaks the entire pipeline.

**Driver:** direct invocation of `subagent`, `send`, `teardown` tools by the
parent pi agent. (See `tools/manual-test/README.md` → "direct tool driver".)

### J2: Subagent resurrect — bring a torn-down agent back

**What:** After teardown, pass the `session_id` surfaced in the teardown
report to the `resurrect` tool. Verify the resurrected agent has access to
its prior conversation, has the same tool restrictions as its original
persona, and that the four documented error paths return the expected
messages.

**Why:** Recovery from premature teardown is the motivating feature of
DR-aligned subagent persistence. If resurrection silently widens tool
surface or loses conversation, the feature is worse than nothing — it's a
capability-escalation bug.

**Driver:** direct invocation of `subagent`/`teardown`/`resurrect` tools by
the parent pi agent.

### J3: Fork — clone parent into a sibling

**What:** Use the `fork` tool to clone the parent's session into a child
that inherits full conversation context, runs an independent task, and
reports back via `<agent_idle>`.

**Why:** Fork is the divergent-exploration primitive used by skills that
want a "fresh-eyes" review without losing the originating context.

**Driver:** direct invocation of the `fork` tool. (Driver: TBD — not
exercised this run; would need a live parent with substantive context to
fork from. Fold into a future topic that genuinely uses fork.)

### J4: Workflow pipeline phase

**What:** Run a single workflow skill (e.g. `manual-testing` itself) end-
to-end via the autoflow harness or by direct invocation, and verify the
expected artifacts land in `docs/`.

**Why:** The pipeline is the user-facing product of this repo. Each phase
must produce its artifact and hand off cleanly to the next.

**Driver:** TBD — exercised implicitly by every autoflow run; explicit
tooling would be a `pi exec` harness that can drive a phase non-
interactively. Fold in when a topic needs it.

### J5: Worktree lifecycle

**What:** `/worktree` create → resume → cleanup, with optional change
transfer.

**Why:** Worktree is the branch-isolation primitive used during multi-topic
development.

**Driver:** TBD — needs a scratch git repo and a way to drive `/worktree`
non-interactively.
