# DR-029: Standalone overlay extension mirroring pi's context-file discovery

## Status
Accepted

## Context
Model-specific prompt tuning needed a home in the codebase. Two plausible paths: integrate it into the subagents extension (where model selection happens at spawn time, giving tight access to agent-level model context) or build a standalone extension that works for any pi session regardless of whether subagents are involved.

The feature also needed a discovery mechanism for overlay files. Options included a dedicated config directory, a manifest file, inline markers in `AGENTS.md`, or sibling files next to existing context files.

## Decision
Built model-aware prompt overlays as a standalone extension (`extensions/model-prompt-overlays/`) that independently mirrors pi's context-file ancestor walk to discover `AGENTS.*.md` siblings of whichever `AGENTS.md` or `CLAUDE.md` pi loads at each context root.

The subagents coupling was rejected because model-specific prompt tuning is a general concern — any session running any model benefits from it, not just subagent-managed sessions. Making it standalone means the feature loads once and works everywhere, with no dependency on orchestration infrastructure.

Sibling discovery (`AGENTS.*.md` next to `AGENTS.md`) was chosen over dedicated directories or manifests because it mirrors the mental model users already have for pi's prompt layering: files in the same directory stack together, scoped from global to project-local.

## Consequences
The extension must independently replicate pi's filesystem discovery algorithm (global agent dir first, then ancestor walk from farthest to nearest). It cannot access a custom `ResourceLoader` or `agentsFilesOverride()` state from inside `before_agent_start`, so if pi changes how it walks directories or adds new discovery roots (e.g., package-level `AGENTS.md`), the overlay extension won't automatically follow — it requires a manual update. This coupling to pi's internal discovery logic is the main cost of the standalone approach. The benefit is zero coupling to any other module in the repo and automatic activation for every session that loads the extension.
