# DR-063: Persona tool whitelists pin the exact surface, codemode rides only when named

## Status
Accepted

## Context
The subagents tool policy treats a persona's `tools:` front-matter list as an exclusive allowlist (`resolveChildToolPolicy`). Codemode straddles two categories. It resembles transport: a script's `tools.<name>` can only call what the session already allows, so granting it adds no reach. But it carries one capability origin: the `models` global spends session credentials on classifier and image models that no whitelist ever named, and `codemode.mode: "only"` hides the very surfaces a whitelist pinned. So the question was whether codemode should ride along automatically with any allowlist or behave as an ordinary whitelisted tool.

The capability/surface test — a surface may only re-expose what the session already holds; capabilities enter a session only as tools — classifies every codemode sandbox global as benign except `models`.

## Decision
A declared `tools:` list pins the exact surface. A persona that wants codemode names it; omission denies it, bulk script fan-out included. Personas without a `tools:` list get the default policy (everything except `ask_user`) and codemode flows in from settings.

Auto-granting codemode for allowlist personas was rejected: it would make whitelisting codemode a silent consent to `models` spending, breaking codemode's orthogonality to capabilities. The clean fix — upstream, registering `classify` and `generate_images` as inactive tools so `models` resolves against the session's callable set — was deferred: the sandbox is built inside `builtin:codemode`, which my-pi cannot gate without replacing the extension wholesale.

## Consequences
Restricted personas without codemode lose parallel tool calls and output filtering, a silent degradation persona authors must anticipate; the rule must therefore stay visible (specialist-design should carry it eventually, not only this record). The leak stands: whitelisting codemode consents to `models`. If upstream ever registers the model capabilities as inactive tools, revisit — at that point codemode becomes pure transport and auto-granting turns defensible.
