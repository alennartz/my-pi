# Plan: ask-user-text-wrapping

## Context

The `NumberedSelectComponent` in `lib/components/numbered-select.ts` truncates text that exceeds terminal width via `truncateToWidth()`. On constrained terminals (e.g., mobile), this clips important content. It should wrap instead. See [brainstorm](../brainstorms/ask-user-text-wrapping.md).

## Architecture

### Impacted Modules

**Components** — the only module affected. `lib/components/numbered-select.ts` changes its rendering strategy from truncation to wrapping for title and option lines. No responsibility or interface changes. `wrapTextWithAnsi` is already available from `@mariozechner/pi-tui` (already a dependency).

## Steps

### Step 1: Add `wrapTextWithAnsi` import

Add `wrapTextWithAnsi` to the existing import from `@mariozechner/pi-tui` in `lib/components/numbered-select.ts`.

**Verify:** No import errors when loaded by pi.
**Status:** not started

### Step 2: Add a `wrapWithIndent` helper

Add a module-level helper function that takes a styled prefix string, styled content string, the total width, and the prefix's visual width. It wraps the content at `width - prefixWidth` using `wrapTextWithAnsi`, then returns lines with the prefix on the first line and `prefixWidth` spaces on continuation lines.

**Verify:** Used by the next two steps.
**Status:** not started

### Step 3: Wrap the title

Replace the `truncateToWidth` call for the title with `wrapWithIndent`. Prefix is `" "` (1 space), content is the styled bold accent title, prefix width is 1. Push all returned lines.

**Verify:** A long title wraps across multiple lines with 1-space indent on continuation lines, instead of being truncated.
**Status:** not started

### Step 4: Wrap option lines

For each option, build prefix and content separately:
- **Highlighted:** prefix = `t.fg("accent", "  > " + num + ". ")`, content = `t.fg("accent", label)` + optional ` ` + `t.fg("muted", desc)`
- **Non-highlighted:** prefix = `t.fg("dim", "    " + num + ".")` + `" "`, content = label + optional ` ` + `t.fg("muted", desc)`

Prefix visual width is 7 in both cases. Use `wrapWithIndent` and push all returned lines. The text-mode input rendering (below highlighted option) stays as-is. Help text lines keep their existing `truncateToWidth` — no change.

**Verify:** Long option labels/descriptions wrap with 7-space indent on continuation lines.
**Status:** not started
