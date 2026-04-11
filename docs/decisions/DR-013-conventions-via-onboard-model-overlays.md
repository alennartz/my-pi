# DR-013: Deliver Personal Conventions via Onboard Model Overlays

## Status
Accepted

## Context
The package needs to ship behavioral conventions for the agent without silently mutating system prompts. Users should be able to see, edit, and opt out of conventions.

Base `AGENTS.md` files often mix broad, model-agnostic instructions. The pause convention is intended to be model-specific (Claude-only), so installing it into base `AGENTS.md` would scope it too broadly.

## Decision
Use the `/onboard` prompt template as the delivery path: show the convention inline and ask the user where to install it.

Install target is a model overlay file, not the base file:
- Project-level: `AGENTS.claude.md`
- Global: `~/.pi/agent/AGENTS.claude.md`

The installed overlay includes frontmatter:

```yaml
models: claude-*
```

This keeps the convention explicit, user-owned, and scoped only to Claude-family models.

## Consequences
- Users own their conventions — they can tweak, extend, or ignore what the package ships.
- The package remains a delivery vehicle, not a hidden override.
- Conventions can now be model-scoped via `AGENTS.*.md` overlays with frontmatter.
- Requires a manual install step, which `/onboard` mitigates but does not eliminate.
