# DR-055: Child sessions always trust their cwd — child-side project-trust machinery is scrapped

## Status
Accepted

## Context
The subagents spawn path once carried its own project-trust machinery: a per-child trust hook with cautious ask-the-user-then-fail-headless behavior, and a review finding proposing to gate foreign-cwd model-tier overlays on the parent's project trust. This was security gating layered on top of pi's own trust model — and the user's ruling cut through it: "scrap the security checks — happily open sub agents into any folder and use all of the files from there." pi's SettingsManager already defaults `projectTrusted: true`; trust *prompting* exists only in the CLI layer, which an SDK child session never passes through. So the child-side machinery was simulating a gate that pi's runtime does not have.

## Decision
Children are opened with no trust hook at all: each child trusts its cwd via pi's default project-trusted state and loads that directory's project resources (`.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/mcp.json`, …) unconditionally. Model-tier overlays are read from the child's effective cwd regardless of any trust flag — tier remapping is user configuration, not a trust boundary. The `confirmProjectAgents` confirmation parameter is removed with the machinery. pi's root CLI trust flow is untouched; trust prompting remains a CLI-layer concern.

Rejected: keeping the ask→no headless trust prompts (explicitly scrapped — a prompt nobody can answer just blocks); re-scoping the trust decision to the child's own cwd (the review's proposed fix — wrong shape: it preserves simulated gating the user does not want); gating tier overlays on the parent's project trust (scope-inconsistent — the parent's trust says nothing about a foreign directory — but the chosen resolution was dropping the gate, not re-scoping it); keeping a dormant trust hook "for future use" (dead configuration surface implying protection that does not exist).

## Consequences
Spawning into a directory loads and runs that directory's code and config — that is the point. The security boundary is the user's choice of which directory to spawn into, made once, not a runtime gate evaluated per child. Costs knowingly accepted: a hostile repo executes its extensions/MCP config the moment a child is opened into it, and the removed cautious behavior is gone for good (its tests were deleted as sanctioned removal, not left red). Future proposals to reintroduce child-side gating should start from this record, not from the instinct that a gate is missing.
