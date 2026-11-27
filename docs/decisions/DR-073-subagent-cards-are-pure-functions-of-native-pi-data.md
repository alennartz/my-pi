# DR-073: Subagent Cards Are Pure Functions of Native Pi Data

## Status
Accepted

## Context
Pimote shows my-pi's subagent operations as cards. my-pi used to build them twice: a semantic adapter parsed partial tool JSON into a live operation feed, and the provider republished saved `details.subagentContent` into that same bounded feed through `rehydrate`. Each Pimote view merged six sources with six dedupe keys. Cards went missing after a late child open, a tree navigation, a compaction, or a resume (audit H2, H3, H4, H5, M6–M10, M12). Saving depended on the `tool_result` hook, which pi skips for validation failures and aborted calls, and custom-message operation IDs came from per-process counters.

Pi already persists every tool call and result, parses partial tool arguments, and streams `onUpdate` details. Pimote already replays native events.

## Decision
A card is a pure function of native data. The provider exposes presenters; Pimote calls them for live events and for saved entries alike.
- Tools call `onUpdate` with the complete current card in `details.subagent`, never a delta. Final results and `subagents` custom messages write the final card in `details.subagent`.
- A call without a card, such as a validation failure or an aborted message, is derived from its arguments and result text.
- Responder text streams to the blocked sender through a progress sink on its correlation. my-pi reads the text from pi-ai's parsed partial arguments, and a new responder attempt replaces it.
- Presenters read the new shape first and the legacy `subagentContent` and `semantic` shapes second, only on read. They never throw and never output router correlation IDs.
- The provider carries topology, controls, and presenters. It keeps no history and no presentation state.

Rejected: keep the feed and turn hydration into a pull API. It keeps the streaming protocol, active-operation snapshots, and two persistence formats, and every rebuild path still has to merge them.

Rejected: derive final cards from the structured tool result alone. Each kind would need its own decoder for data the tool already has in typed form when it returns.

## Consequences
Live and reloaded cards share one code path, so they cannot diverge. The parity harness checks this for every kind.

Saved sessions carry cards with root-relative paths. A child resurrected at another path shows its old paths in cards written before the move.

The legacy reader stays until no saved session needs it. It is the only place that knows the old shapes.
