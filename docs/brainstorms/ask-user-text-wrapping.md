# Brainstorm: ask-user-text-wrapping

## The Idea

The `NumberedSelectComponent` (used by the `ask_user` tool) truncates text that exceeds terminal width via `truncateToWidth()`. On constrained terminals (e.g., mobile), this clips important content. It should wrap instead.

## Key Decisions

1. **Wrap everything except help text.** Title, option labels, and option descriptions all wrap. Help text stays truncated — it's short, formulaic, and not worth the vertical space of wrapping.

2. **Continuation lines align with text, not the number prefix.** When an option wraps, continuation lines indent to align with the label text start (7 chars), e.g.:
   ```
     > 1. This is a really long option
          label that wraps to the next
          line
   ```
   This keeps the number/bullet prefix visually distinct from the content.

3. **Separate prefix from content before wrapping.** Build the styled prefix and styled content independently, wrap the content at `width - prefixWidth` using `wrapTextWithAnsi`, then stitch: prefix on first line, indent spaces on continuation lines. This avoids ANSI codes tangling with layout math.

4. **Title continuation lines get 1-space indent** to match the first line's `" " + title` format.

## Direction

Modify `lib/components/numbered-select.ts`:
- Import `wrapTextWithAnsi` from `@mariozechner/pi-tui`.
- In `render()`, replace `truncateToWidth` calls on title and option lines with prefix/content separation + `wrapTextWithAnsi` + indent stitching.
- Keep `truncateToWidth` for help text lines only.

## Open Questions

None.
