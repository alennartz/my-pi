# Plan: User Edit Tool

## Context

A new extension that provides a `user_edit` LLM tool. The LLM calls it with a file path, pi opens the file in the built-in editor UI for the user to edit manually, and on save the tool writes the file to disk. See [brainstorm](../brainstorms/user-edit-tool.md).

## Architecture

### New Modules

**User Edit extension** (`extensions/user-edit/index.ts`) — single-file extension registering one tool. No dependencies on other repo modules.

### Interfaces

**`user_edit` tool**

- **Parameters:** `{ path: string }` — file path, resolved relative to `ctx.cwd`. Leading `@` stripped (model quirk normalization).
- **Behavior:**
  1. Resolve `path` to absolute against `ctx.cwd`.
  2. Read existing file contents, or empty string if the file doesn't exist.
  3. Open `ctx.ui.editor(path, content)` — the raw `path` parameter (not the resolved absolute path) is used as the title so the user sees what the LLM asked for.
  4. If the user cancels (returns `undefined`), return `"User cancelled editing <path>"`.
  5. If the user saves, write the edited content to disk using `withFileMutationQueue` on the resolved absolute path. Create parent directories if needed.
  6. Return `"User saved <path>"`.
- **File mutation safety:** The `withFileMutationQueue` call covers only the write, not the full read→editor→write window. The editor is a blocking user interaction that can take arbitrarily long — holding the queue lock during that time would block all other writes to the same file. The read-before-editor is outside the queue; the write-after-editor is inside it. This means a concurrent write could land between the read and the user's save, and the user's save would overwrite it. That's acceptable — the user is looking at the content and making a deliberate choice to save.
- **Error handling:** File read errors (permission denied, binary file, etc.) throw, surfacing the error to the LLM. Write errors similarly throw.

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

## Steps

**Pre-implementation commit:** `5001acde77efbcc277e8f075a0aa4c53638c1e6b`

> **Skipped.** Work through the architecture methodically — identify affected files,
> make changes in a logical order, and commit in coherent units.
