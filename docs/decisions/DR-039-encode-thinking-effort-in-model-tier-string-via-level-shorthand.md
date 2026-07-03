# DR-039: Encode subagent thinking effort in the model-tier string via pi's `:level` shorthand

## Status
Accepted

## Context
Subagent model tiers lacked a way to specify thinking effort — a `smart` tier pointing at Opus 4.8 would boot the child at the session default level rather than `xhigh`. Two approaches were on the table: (1) add a separate `thinking` field to tier config, agent frontmatter, and spawn params, requiring `--thinking` plumbing through the extension; (2) reuse pi's existing `model:level` shorthand, which already passes through to `--model` intact.

## Decision
Reuse pi's `:level` shorthand — tier values remain plain strings (e.g., `"anthropic/claude-opus-4-8:xhigh"`), passed unchanged to the child's `--model`. Pi's own resolver handles the model/level split, clamping to supported levels, and adaptive-thinking translation. The only extension change was making availability checks suffix-tolerant: strip a trailing valid level before registry lookup; carry the full string through on success.

The separate-axis approach (nested `{ model, thinking }` config + `--thinking` wiring) was rejected because it would duplicate a mechanism pi already owns cleanly. Pi's clamping and adaptive-thinking translation still live downstream — the extension's plumbing would have been a thin passthrough adding surface area without value.

## Consequences
Thinking is not independently configurable from a model — there is no "session-default model at xhigh" knob. Tier names cannot take a level suffix; the tier string is atomic. Model IDs whose last colon-segment coincidentally matches a valid level (e.g., a hypothetical `acme/model:high`) would be misparsed — accepted as an unlikely collision given the six-word level vocabulary.
