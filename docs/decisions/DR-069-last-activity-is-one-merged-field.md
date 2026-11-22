# DR-069: Last activity is one merged field

## Status
Accepted

## Context
The subagent node projection carried two display fields: `activity` (the last
tool call the child started) and `lastOutput` (the last assistant text).
Pimote's side-pane inspector rendered both as separate rows. A client cannot
merge them correctly: the fields update independently with no ordering
between them, so "the last thing the agent did" is unknowable from the
payload alone. The panel also showed nothing for a settled child, because
settle paths cleared `activity` while `lastOutput` survived — the two fields
had different lifecycles for no consumer benefit.

## Decision
`lastActivity` is the single "last thing the agent did" field. Tool
execution starts write the `tool(args)` summary as before; assistant messages
now overwrite it with a one-line preview of the message text
(`activityPreview`, whitespace collapsed, capped at 200 characters). Settle
paths (idle, errored, dead) stop clearing it, so a settled child keeps
showing its final action. `lastOutput` remains internal — parent-facing
completion payloads, status lines, and output previews still carry the full
text — but it no longer appears on the node projection. Restored children
seed `lastActivity` from the transcript's last assistant text via the
lifecycle status. Pimote's `SubagentNodeSnapshot` drops `lastOutput`, and the
inspector renders one "Last activity" row.

Applying the merge at the source was chosen over a client-side heuristic
(prefer `activity`, fall back to `lastOutput`) because the client cannot
order the two fields. A new separate merged field projected only to Pimote
was rejected: two concepts describing the same fact would drift, and the
TUI dashboard and parent-facing status lines would keep showing a stale
tool command after the agent's final message.

## Consequences
Every surface that reads `lastActivity` — the Pimote panel, the pi TUI
dashboard, and parent-facing status lines — now shows the latest tool call
or message text, whichever happened last. Truncation at the source (200
characters) bounds status lines and panel rows; the full text survives only
in parent-facing outputs that already carried it. Dropping `lastOutput`
from the node snapshot is a breaking change for external consumers of the
Pimote subagent projection.
