# User Edit Tool

## The Idea

A pi extension that provides an LLM tool called `user_edit`. The LLM calls it with a file path, and pi opens the file in the built-in editor UI so the user can manually edit it. On save, the tool writes the file to disk. This gives the LLM a way to hand control back to the user for manual edits within the agent flow.

## Key Decisions

- **Minimal tool result** — the tool returns only whether the file was saved or the user cancelled. No diff, no full content. Keeps things simple and avoids noise for large files. Can be revisited later if the LLM needs more context about what changed.
- **New file support** — if the file doesn't exist, the editor opens empty. On save, the file is created (including parent directories). This makes the tool work for both editing existing files and creating new ones.
- **Editor UI via `ctx.ui.editor()`** — uses pi's built-in multi-line editor dialog. The file path is shown as the editor title so the user knows what they're editing.
- **Single file extension** — small enough to be a single `.ts` file. No dependencies, no multi-file structure needed.

## Direction

Build a single-file extension that registers one tool (`user_edit`) with one parameter (`path`). The tool reads the file (or starts empty), opens `ctx.ui.editor()`, and writes on save. Returns a minimal result string to the LLM.

## Open Questions

- None at this stage. Intentionally minimal — can extend later (diff in result, line number jumping, read-only mode, etc.).
