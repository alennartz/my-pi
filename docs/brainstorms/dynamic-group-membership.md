# Dynamic Group Membership

## The Idea

The subagents extension currently enforces one active group at a time with fixed membership — once spawned, you can't add or remove agents. This blocks a concrete workflow: an agent with an active group wants to fork itself (or spawn additional agents) for a side task and can't. The goal is to make group membership dynamic so agents can be added and removed throughout a group's lifetime.

## Key Decisions

### Dynamic membership over multiple concurrent groups

Both approaches solve the same core problem (can't spawn new work while a group is active). Dynamic membership is simpler because it preserves the "there is one group" mental model — no tool disambiguation, no notification multiplexing, no multi-widget rendering. The LLM's existing understanding of `subagent`, `send`, `teardown` doesn't change structurally. Multiple concurrent groups would require group IDs threaded through every tool call.

### Same tools, behavior changes when group is active

`subagent` and `fork` keep their current schemas (fork gains an `id` field). When no group exists, they create one (today's behavior). When a group is active, they add to it. No new tools, no flags, no "add mode." The acknowledgment message changes ("Added N agents to existing group" vs "Group spawned"). Validation scopes to the full group — new agent IDs must be unique across all existing + new agents, channel references can target existing or new agent IDs.

### Asymmetric topology for added agents

New agents can send to existing agents. Existing agents don't gain channels to new agents. Rationale: new agents are spawned by the parent with knowledge of the current group, so they naturally know who's there. Existing agents were set up before the new ones existed. If an existing agent needs to reach a new one, the parent can relay. Forked agents specifically get parent-equivalent access — they can send to all agents in the group, since they're a clone of the parent.

### Individual agent teardown via `teardown` tool

Rename `teardown_group` to `teardown`. No args = kill everything (today's behavior). `teardown({ agent: "some-id" })` kills just that agent — stops its process, removes it from the broker/topology/entries/widget instantly. When the last agent is removed, the group auto-cleans (broker shutdown, widget removal, `activeGroup` nulled). The LLM can call `subagent` again afterward to start fresh.

### Fork gets an explicit `id` parameter

Today fork hardcodes id `"fork"`, which breaks if you fork twice into the same group. Adding a required `id` parameter (same as subagent's agent items) lets the LLM pick meaningful names and avoids collisions.

### Removed vs crashed agents

The broker's `agentDied()` already handles cleanup mechanics (synthetic error responses to blocked senders, deadlock edge removal, socket cleanup). Individual teardown uses the same path but with a distinct error message ("agent was removed" vs "agent crashed") so peers get appropriate feedback.

## Direction

Modify the existing subagent extension to support dynamic group membership:

- `subagent`/`fork` add to existing group when one is active (instead of erroring)
- `teardown` (renamed from `teardown_group`) supports per-agent removal via optional `agent` parameter
- Topology, broker, GroupManager, and widget all support add/remove operations
- Fork schema gains required `id` field
- No new tools, no multi-group complexity

## Open Questions

- Should the auto-cleanup on last agent removal also clean up the widget immediately, or leave a brief "empty group" state? (Leaning toward immediate cleanup.)
- When adding agents to a live group, should the acknowledgment list existing agents too, or just the new ones? (Leaning toward just new ones — the LLM already knows who's there.)
