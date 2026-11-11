# Brainstorm: Pimote Subagent Views

## The idea

Pimote should present my-pi subagents as first-class interactive views, not panel-card summaries. A user can inspect and chat with a live child session inside its parent root session.

This brainstorm covers the `@pimote/sdk/subagents` seam and its my-pi provider. Root-to-root communication is a separate Pimote feature. My-pi keeps its existing local subagent tools, channels, and parent-local routers. The root feature does not reuse those tools or routes.

A subagent view borrows the existing child `AgentSession`. It does not create another runtime, promote the child to a root, or transfer lifecycle ownership.

## Key decisions

### First-class SDK seam

Pimote will replace its subagent panel-card projection with a typed `@pimote/sdk/subagents` seam. My-pi implements the provider over its existing root-scoped `AgentSessionRegistry`. Pimote owns the hierarchy visualization, child views, and client attachments.

The provider exposes:

- The live root-relative hierarchy, with stable references to child sessions.
- Membership and lifecycle changes.
- Task, persona, model, thinking level, state, current activity, usage, context fill, errors, waiting targets, and pending correlations.
- Existing parent-local communication channels as read-only directed edges.
- On-demand access to each child's existing live `AgentSession`.
- Separate send, receive, response, and failure events with full text, correlation metadata, and source and target references.

The provider publishes communication events whether or not a child view is open. These events are not a second transcript. The live Pi session remains the source of transcript history.

### Borrowed child sessions

Opening a child view acquires a lease to its existing `AgentSession`. Pimote subscribes to session events and reads the saved conversation without opening the child JSONL file in another runtime. Multiple clients can hold views on one child. Releasing a lease detaches a client and never disposes the child.

Pimote subscribes before it reads the transcript snapshot so it does not miss changes. The SDK preserves the my-pi provider's lifecycle authority when a child is replaced or removed.

### Interactive hierarchy

Pimote shows the full live hierarchy inside the parent session, not in the root active-session bar. Users can open multiple descendants and select one child view at a time. Switching views does not close the previous view. The tree shows which children remain attached.

A newly opened view shows the child's full saved conversation. An assistant message or tool result already in progress can appear after it completes. Later messages stream normally.

A child view supports ordinary chat, Stop, model and thinking selection, compaction, and branch navigation. It does not expose new-session, resume, fork, or teardown commands. Subagents stay headless and do not gain dialog tools.

If the parent tears down a child while a user views it, Pimote closes the view and explains the removal. The child session file remains available for resurrection.

### Parent notifications while a child is viewed

While any Pimote client holds a child view, my-pi holds that child's automatic idle notification. Explicit local child-to-parent messages and responses remain available.

When the last client detaches, my-pi sends only the latest held idle answer to the parent. Earlier answers remain in the child transcript. A short reconnect grace period prevents a transient disconnect from detaching a view.

Stopping a child clears held idle answers. If the parent awaits that child, detach releases the wait with the child's status. Stop sends no unsolicited idle answer.

## Why this direction

My-pi already owns each child runtime and its parent-local communication rules. Opening the same child session file as a normal Pimote session risks a second writer. Lending the live runtime preserves one owner and avoids one permanent Pimote slot per child.

A typed SDK provider gives Pimote structured ownership, lifecycle, channel, and communication data. Cards flatten that information and hide child identity from the host. A first-class seam lets Pimote render the hierarchy and attach interactive views without taking runtime ownership.

## Open questions for architecture

### Sharp questions

- What exact interface gives Pimote a consistent initial tree snapshot, ordered lifecycle changes, communication events, and child-session leases?
- Which reference identifies a child across path reuse and internal session replacement?
- What replay and retention rules apply to lifecycle and communication events after a Pimote client disconnects or the server restarts?
- How does the view adapter share transcript serialization, event buffering, and command handling without registering children as root `ManagedSlot`s?
- How does Pimote rebind a view when my-pi replaces a child's runtime, or report that the child is no longer available?
- Which WebSocket changes also affect the Android client?
- Which normal Pi controls remain available in a child view beyond the agreed chat, stop, model, thinking, compaction, and branch controls?
- The selected wait behavior conflicts with my-pi DR-025: `await_agents` currently resolves when children settle, while this design keeps it open until the final view detaches. Confirm and record the DR change during architecture.

### Fog

- The exact hierarchy layout, motion, message previews, status transitions, and narrow-screen behavior need visual design in architecture mockups.
