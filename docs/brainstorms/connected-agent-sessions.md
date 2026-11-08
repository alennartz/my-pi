# Connected Agent Sessions

## The idea

Pimote should make my-pi subagents first-class interactive entities, not panel-card summaries. A user can open a live subagent inside its parent session, inspect its conversation, and chat with it. Root sessions can also connect through NATS so my-pi agents on different machines can communicate later.

The system has two related but distinct forms of communication:

- **Subagent communication** stays under the existing my-pi owner tree and parent-local channel rules.
- **Root-session communication** uses persistent connections and NATS. Its delivery model must support future cross-machine transport.

A Pimote child view borrows the existing child `AgentSession`. It does not create another runtime, promote the child, or transfer lifecycle ownership.

## Settled decisions

### One messaging tool surface with separate providers

A shared my-pi messaging extension owns one `send` and one `respond` tool. Separate providers implement the available routes:

- The subagent provider uses my-pi's current local message routers.
- The root-session provider uses NATS-backed root connections.

Separate extensions do not register duplicate tool names. They provide route capabilities to the shared messaging extension through an extension-to-extension seam. The exact module names and tool schemas remain for architecture.

Subagent `send(expectResponse: true)` keeps its current blocking behavior. Root-session replies are asynchronous. Root `send` reports broker acceptance and does not wait for the other agent to answer. The tool does not claim that an agent received or processed the message.

Root-session incoming messages start a new turn when the target is idle. While it is working, incoming messages use Pi's steer behavior. Do not add a delivery-mode choice in the first version. The sender receives no special warning that the target is not actively reading messages.

A recipient can call `respond` with the correlation ID it received. It must not need the latest system-prompt target list to answer. Session routing resolves the response through the stored correlation origin.

Subagent identity and peer instructions should use a named structured system-prompt section, not `appendSystemPrompt`. The section should explain the child identity, task, currently permitted subagent peers, and message protocol. The connected-root target list can use the same structured-section mechanism. Pi owns when it refreshes sections; architecture must verify the actual extension lifecycle before depending on mid-interaction refresh.

### Root-session connections

The first NATS connection model joins roots only. Do not connect a root directly to a subagent, or connect subagents across trees through NATS. Existing subagent-to-parent and subagent-to-peer channels remain in my-pi.

A connection joins two exact root identities. It is bidirectional, takes effect immediately, and does not require peer acceptance. It has a lifecycle independent of session creation. Connections persist until explicitly disconnected. Closing a session does not close its connections.

Users can connect any two roots. A root agent can create or remove only a connection involving its own root. It cannot change connections between other roots. Subagents do not create NATS root connections in the first version. Connection management does not create sessions.

Users need a copyable session-address command and a connect command that accepts that address. A simple copy/paste flow avoids depending on the built-in TUI selector, which cannot search long lists. Agent-facing tools need session discovery and connect/disconnect operations before any connection exists. The names and argument shapes are provisional. Example commands are `/session-address`, `/connect <address>`, and `/disconnect <address>`.

### Session identity and display names

The Pi session UUID identifies the root conversation. Display names and folder names are discovery and presentation metadata, not identities. Renaming a session does not change its identity. A fork or new conversation has a new identity.

The exact printable address format, any broker namespace, and name-based completion remain open for architecture. Do not expose a NATS subject as the durable session identity. Pi fork lineage does not create a messaging connection: each new or forked conversation has its own UUID.

### Registration, archive, and message delivery

A root registers with the broker when its Pi session opens. Pimote manages one local NATS server per machine and stops that server with Pimote. CLI sessions can use the local server while it runs. If Pimote stops, root-to-root messaging is unavailable until it restarts. Existing my-pi subagent routing remains local.

Discovery reads broker registrations. It does not claim that an agent is currently listening. No availability probe or agent-presence protocol is in scope. The exact distinction between a registered closed session and an open session is for architecture.

Archive removes the session's broker registration, connections, queued messages, and pending requests. Archived sessions do not appear in discovery. Unarchive does not restore those relationships or messages. Opening an archived session from Pi CLI also unarchives it through Pimote before registration. If Pimote is stopped, that broker registration and unarchive operation wait until it returns.

Connections and queued messages survive a Pimote/NATS restart. Message-level delivery guarantees, duplicate handling, reply expiry, and acknowledgement semantics remain unresolved and belong to the NATS architecture deep dive.

### First-class Pimote subagents

Pimote will replace its subagent panel-card projection with a typed `@pimote/sdk/subagents` seam. The root my-pi extension implements a provider over its existing `AgentSessionRegistry`. The provider exposes:

- A root-relative hierarchy with stable references for live nodes.
- Membership and lifecycle changes.
- Task, persona, model, thinking level, state, current activity, usage, context fill, errors, waiting targets, and pending correlations.
- Existing communication channels as read-only directed edges, resolved to unambiguous tree references.
- On-demand access to each child’s raw live Pi `AgentSession`.
- Separate communication events for sends, receives, responses, and failures. These include full text and correlation metadata. Pimote's visual layer can show previews, animate flow, and link to the relevant child without reconstructing transcripts.

The provider must publish communication events even when Pimote has no child view open. It monitors the existing routers. Emit separate send and receive events with full text, correlation metadata, and source/target references. Replies are correlated communication events too. The event feed is not a second saved transcript. Pimote can inspect the raw child session for the latest conversation text instead of copying it into the tree snapshot. The raw child session remains the source for full transcript history.

The SDK should give Pimote a consistent initial tree snapshot and subsequent changes. It should preserve the authoritative provider lifecycle when my-pi replaces or removes a child. A child view acquires a lease to the existing session; release drops the view only. Multiple Pimote clients can hold views on one child. Pimote does not open the child JSONL file through another runtime.

### Interactive subagent views

Pimote shows the whole live subagent hierarchy inside the parent session, not as root sessions in the active-session bar. Users can open multiple descendants under one parent. Only one child conversation needs to be selected at a time. Switching between children does not close the previous view. The tree shows which children remain attached.

Opening a child presents its full saved conversation. If an assistant message or tool result is already in progress, it can appear when complete. Later assistant messages stream normally. The UI uses the child’s existing tools and permissions. Opening a view does not grant more tools or UI capabilities.

Subagents remain headless and do not gain dialog tools. The child view supports ordinary chat, Stop, model and thinking selection, compaction, and branch navigation. It does not expose session-replacement commands such as new, resume, or fork. Pimote offers Stop, but not teardown. Teardown remains the parent’s authority.

Closing a view never disposes the child. If the parent tears the child down while a user is viewing it, Pimote closes that view and explains the removal. The child session file remains available for resurrection.

### Parent notifications while a user views a child

While at least one Pimote client has a child view open, my-pi holds that child’s automatic idle notification. The parent’s `await_agents` continues waiting. Explicit sends and responses between the child and parent remain available.

When the last client closes the child view, my-pi sends only the latest held idle answer to the parent. Earlier held answers remain in the child transcript. Switching away from a child does not close its view. A lost connection gets a short reconnect grace period before it counts as a detach.

Stopping a child clears held idle answers. If the parent is explicitly awaiting that child, detach releases the wait with the child’s status. Stopping does not send an unsolicited idle answer to the parent.

## Why this direction

The my-pi child runtime already exists and remains owned by its parent. Opening the same child session file as a normal Pimote session could create a second runtime and duplicate writes. Lending the live session avoids that conflict and avoids one permanent Pimote slot per child.

A first-class provider gives Pimote structured ownership, lifecycle, and channel data. Cards flatten that information into a presentation snapshot and hide subagent identity from the host. A provider allows the UI to render a hierarchy and communication flow directly.

The shared messaging extension keeps the model-facing tool names consistent across providers. This avoids duplicate tool registration while retaining my-pi's local routing and enabling Pimote's NATS transport.

The Pi session UUID survives display-name changes. Separating identity from labels supports copy/paste addresses and future transport changes.

NATS fits the future cross-machine requirement. A local NATS server adds a process but does not require ordinary Pimote sessions to move to pi-durable. A local Linux x86-64 measurement of NATS Server 2.15.2 with JetStream used a 7.3 MB compressed download, a 18.9 MB binary, and about 18 MB idle resident memory. Treat these as a baseline, not a deployment guarantee.

## Open questions for architecture

### NATS and delivery semantics

- Which JetStream streams, consumers, and retention policies store root registrations, connections, queued messages, and replies?
- What does a successful root `send` receipt mean: accepted into JetStream, delivered to the target runtime, or something else?
- How does the receiving host acknowledge a message after admitting it to a Pi session? What happens if it crashes between broker delivery and session persistence?
- What is the idempotency key? How do redelivery and duplicate tool calls avoid duplicate user messages or model turns?
- How do asynchronous replies find the source session after a restart? How long do correlations and unanswered requests remain valid?
- What happens to pending messages and replies when a connection is explicitly disconnected or a session is archived?
- What storage quotas, maximum message sizes, expiry, and dead-letter behavior protect the local broker?
- How does NATS authenticate and authorize CLI clients on one machine? What security changes are required for a later multi-machine topology?
- Does the connection directory distinguish closed registrations, or return all registered identities without claiming presence?
- How does a CLI process opening an archived session request unarchive and register it through Pimote?

### Subagent SDK and Pimote integration

- What exact provider interface exposes tree snapshots, ordered lifecycle updates, read-only channel edges, and raw session leases?
- What stable tree reference distinguishes a removed child from a later child that reuses its local ID?
- How does the host acquire a child lease without creating a permanent slot, and how does it subscribe before reading a transcript snapshot without missing events?
- Which session events does Pimote map through the existing session transcript renderer, and which remain provider-only events?
- How does the view follow an internal child runtime replacement, or report that the child identity became unavailable?
- How does the provider expose attachment counts to my-pi, and how does it clear held answers if the parent itself shuts down?
- What replay or retention contract applies to lifecycle and communication events when the Pimote client disconnects or the server restarts?
- Which Pimote wire changes affect only the web client, and which require an Android protocol update?
- Which normal Pi commands are available in a child view besides the agreed safe settings and branch controls?

### Tool and address interfaces

- What names and schemas should the shared `send`, `respond`, `find_sessions`, `connect_session`, and `disconnect_session` tools use?
- How should discovery return current labels, folders, and UUIDs without implying that a registered agent is listening?
- What exact slash commands expose the current session address and connect or disconnect roots?
- Does agent discovery include previously registered closed roots by default, or offer a filter without adding presence claims?
- What happens when two CLI/Pimote processes attempt to register or open the same Pi session identity?

## Visual design to resolve in architecture

Pimote will remove the current subagent panels projection. Its subagent tree will display lifecycle and channel data directly. Communication events are distinct directional UI elements between nodes. The initial visual direction is small flow animations with message bubbles that can show text previews. The exact hierarchy layout, motion, preview length, status transitions, and narrow-screen behavior belong in the architecture mockups.
