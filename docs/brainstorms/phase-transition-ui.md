# Phase Transition UI

## The Idea

Improve the workflow phase transition dialog (the `workflow_phase_complete` tool) with two capabilities: inline text annotations on any option, and number-key shortcuts for instant selection.

The current dialog uses `ctx.ui.select()` — a plain list with arrow keys + enter. It works, but the common case (you know which option you want) is slower than it needs to be, and the "not done yet" case forces a follow-up exchange because the agent has no context about *what* isn't done.

## Key Decisions

### Custom component instead of `ctx.ui.select()`

The built-in `select` doesn't support inline text input or number-key shortcuts. This needs a custom component via `ctx.ui.custom()`. The questionnaire extension example demonstrates the pattern — custom render/handleInput/invalidate with an embedded text editor.

**Why:** `ctx.ui.select()` is a closed API. Both new features require control over keyboard routing and rendering that it doesn't expose.

### Two parallel input paths

- **Fast path:** Press a number key (1, 2, 3) → instantly submits that option with no annotation. No arrow navigation needed.
- **Detailed path:** Arrow keys to highlight → Tab to open inline text input → type clarification → Enter to submit selection + annotation.

**Why:** The fast path covers the 90% case where you know what you want. The detailed path covers the case where you need to add context. Keeping them parallel avoids modal complexity — you commit to one path or the other, so there's no ambiguity about whether a number key is a selection shortcut or text input.

### Text input clears on option change

If you tab into text mode, type something, then arrow to a different option, the text clears. The clarification belongs to whichever option you submit, not accumulated across options.

**Why:** No per-option state to manage. The clarification is about your *current choice*, not a form you're filling out. Simpler mental model, simpler implementation.

### Annotation folded into tool result

The typed text gets appended to the tool result content that the LLM sees. For example, instead of `"User indicated this phase isn't complete yet"`, the agent sees `"User indicated this phase isn't complete yet. User's note: error handling in auth module still needs work"`.

**Why:** The whole point is to avoid the follow-up exchange where the agent asks "what still needs work?" The annotation gives the agent enough context to act immediately.

## Direction

Replace the `ctx.ui.select()` calls in `workflow_phase_complete` with a custom TUI component that renders numbered options with an optional inline text input. The component handles two keyboard modes:

1. **Default mode:** Number keys select instantly. Arrow keys navigate. Tab enters text mode on the highlighted option.
2. **Text mode:** All keys go to the text input. Enter submits. Escape exits text mode (back to default). Arrowing to a different option clears text and exits text mode.

The existing transition logic (flexible vs. fixed transitions, pending transition state, new-session handoff) stays unchanged. This is purely a UI-layer change to the selection interaction inside the tool's `execute` method.

## Open Questions

- **Escape behavior in text mode:** Should Escape exit text mode (back to option navigation) or cancel the entire dialog? Exiting text mode is more forgiving, but it adds an extra keystroke to cancel. Current lean: Escape exits text mode first, then a second Escape cancels the dialog.
