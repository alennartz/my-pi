# DR-062: Retire the Onboard Prompt; Package Discovery Lives in docs/extensions.md

## Status
Accepted

## Context
Supersedes DR-013 (Deliver Personal Conventions via Onboard Model Overlays), deleted at commit `03b6f8fd3ace71dda1476a34fe9660add300b17c`.

DR-013 made `/onboard` the delivery path for personal behavioral conventions: the prompt showed convention text inline and offered to install it into model-scoped `AGENTS.claude*.md` overlays, then walked through subagent model-tier configuration (`~/.pi/agent/model-tiers.json`). It also carried a package tour narrating every module.

Since then the tour became redundant: the `my-pi-docs` extension injects the `docs/extensions.md` path into the system prompt every session, giving agents a living reference instead of a prompt-baked snapshot that goes stale with each module change. The owner also no longer wants the guided flows themselves — the conventions-install offer has served its purpose (conventions already live in the owner's own overlay files, owned and editable there), and tier configuration needs no walkthrough: the system prompt already advertises the tier vocabulary and `list_models` exposes the catalog at runtime.

Alternatives considered: trimming `/onboard` down to just the tier walkthrough (rejected — the owner does not want the flow at all, and the runtime surfaces already cover it); moving the conventions into a standalone skill (rejected — same objection, plus a second delivery path for content the owner curates by hand).

## Decision
Delete `prompts/onboard.md`. Package discovery goes through `docs/extensions.md` via the `my-pi-docs` injected pointer. There is no replacement delivery path for conventions: they exist only where the owner installed them. DR-013 is superseded.

## Consequences
- New machines get no guided setup; configuration knowledge lives in `docs/extensions.md` and runtime discovery (system-prompt tier table, `list_models`).
- `model-tiers.json` remains user-authored configuration; the agent still helps configure it when asked, without a bundled script for it.
- Deleting the prompt does not uninstall conventions already installed into overlay files; those stay until edited by hand.
