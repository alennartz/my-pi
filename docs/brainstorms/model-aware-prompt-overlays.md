# Brainstorm: Model-Aware Prompt Overlays

## The Idea

Create a standalone pi extension that appends model-specific prompt overlays on top of the normal `AGENTS.md` prompt stack. The goal is to let users keep shared conventions in `AGENTS.md` while adding model-tuned guidance for different model IDs such as `claude-*`, `gpt-*`, or `o3-*`.

This is motivated by real behavior differences across models: some models need stronger "pause before acting" guidance, while others need the opposite. The solution should preserve a single shared base prompt without forcing users to duplicate or fork their full prompt per model family.

## Key Decisions

### Standalone extension, not a subagents feature

This should be a new extension that works for any pi session that loads it. It is not coupled to `subagents`. If another session or subagent also loads the extension, it gets the same behavior simply because the extension is active there.

**Why:** The problem is general prompt engineering per model, not specialist-agent orchestration.

### Base prompt stays in `AGENTS.md`

`AGENTS.md` remains the shared, model-agnostic prompt layer. Model-specific files only append additional guidance.

**Why:** Shared conventions should live in one place. Full prompt duplication would drift over time and make maintenance unpleasant.

### Overlay files live next to normal `AGENTS.md` files

The extension should discover overlay files in all the same places pi already looks for `AGENTS.md`, and treat them as siblings of those base files.

**Why:** This keeps the feature native-feeling and avoids inventing a second prompt resource system.

### Overlay filename convention: `AGENTS.*.md`

Overlay discovery should only consider files matching `AGENTS.*.md`.

**Why:** The extension needs a clear discovery boundary. Scanning arbitrary markdown files would be noisy and error-prone.

### Applicability comes from frontmatter, not the filename

Each overlay file must include frontmatter with a required `models:` field. The filename is just for discovery.

Example shape:

```yaml
---
models:
  - claude-*
  - claude-sonnet-*
---
```

**Why:** This keeps naming flexible while making matching explicit and easy to read.

### Match on model ID only

Overlay matching should use model ID globs such as `claude-*`, `gpt-*`, or `o3-*`. It should not key off provider.

**Why:** This is about prompt engineering for model behavior. If the same model is routed through different providers, it should still get the same overlay behavior.

### One file may target many model patterns

A single overlay file may list multiple model ID globs under `models:`.

**Why:** Some guidance may intentionally apply to more than one model cluster, and forcing one file per pattern would create unnecessary duplication.

### Append-only behavior

Matching overlays are appended to the effective prompt. They do not replace, remove, or rewrite earlier prompt layers.

**Why:** The initial goal is prompt layering, not prompt surgery. Append-only behavior is easier to reason about and safer for a first version.

### Matching overlays stack

If multiple overlay files match the current model, all of them apply.

**Why:** This supports layered prompt tuning, such as broad guidance for `claude-*` plus narrower guidance for `claude-sonnet-*` or a specific model.

### Scope stacking should mirror normal `AGENTS.md` behavior

If matching overlays exist at multiple discovered levels, they all stack the same way normal `AGENTS.md` files stack.

**Why:** Users already expect prompt layering across global/project/package scopes. The overlay feature should preserve that mental model.

### Per-scope adjacency

Within each discovered scope, apply the local `AGENTS.md` first, then any matching overlay files for that same scope, then continue to the next nearer scope.

**Why:** This keeps overlay guidance conceptually attached to the base prompt layer it is refining.

### Overlay order is broad → narrow by glob specificity

Within a scope, matching overlays should be ordered from broader model globs to narrower model globs.

Examples:
- `claude-*`
- `claude-sonnet-*`
- `claude-sonnet-4-5`

**Why:** Later appended instructions usually carry more weight, so more specific tuning should come after broader family guidance.

### Silent by default

Normal use should not announce matched overlays in the UI.

**Why:** This should feel like prompt layering, not an always-visible mode switch.

### Malformed overlays are ignored

If an overlay file is malformed or missing a valid `models:` field, ignore it and optionally show a subtle notification.

**Why:** A bad overlay should not break the session or the rest of prompt assembly.

## Direction

Build a reusable extension that augments pi's existing `AGENTS.md` layering model with model-aware, append-only overlays. The extension should:

1. Discover sibling `AGENTS.*.md` files anywhere pi discovers `AGENTS.md`
2. Parse required `models:` frontmatter from those files
3. Match overlays against the active model ID using globs
4. Append all matching overlays in deterministic order:
   - normal scope layering
   - per-scope adjacency
   - broad → narrow within a scope

This gives users a clean way to keep shared prompt conventions while compensating for different model biases without duplicating their whole prompt.

## Open Questions

- What is the exact frontmatter validation/parsing behavior for `models:`?
- What precise algorithm should define glob specificity for ordering?
- What is the cleanest way for the extension to discover all existing `AGENTS.md` search roots in the same order pi uses today?
- Should a future version add an explicit inspection/debug command, even if v1 stays silent by default?
