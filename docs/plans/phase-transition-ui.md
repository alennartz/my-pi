# Plan: Phase Transition UI

## Context

Improve the workflow phase transition dialog with number-key shortcuts for instant selection and an optional inline text annotation on any choice. See [brainstorm](../brainstorms/phase-transition-ui.md).

## Architecture

### Impacted Modules

**Workflow Extension** — The two `ctx.ui.select()` calls in `workflow_phase_complete`'s `execute` method are replaced with calls to a new shared component. The transition logic after the user picks (flexible vs. mandatory, `pendingTransition`, `STOP_TEXT`, `NOT_DONE_TEXT`) is unchanged. When the component returns an annotation, the workflow extension appends it to the tool result text sent to the LLM.

### Interfaces

**`showNumberedSelect`** — Generic reusable component, lives at `lib/components/numbered-select.ts`.

```typescript
interface NumberedSelectOption {
  label: string;
  description?: string;
}

interface NumberedSelectResult {
  index: number;
  label: string;
  annotation?: string;
}

async function showNumberedSelect(
  ctx: ExtensionContext,
  title: string,
  options: NumberedSelectOption[],
): Promise<NumberedSelectResult | undefined>
```

- Returns `undefined` on cancel (Escape in navigation mode).
- `annotation` is `undefined` when the user didn't type anything (fast-path number key or arrow+enter without tabbing).
- Throws if `options` is empty or has more than 9 items.
- Uses `Input` from `@mariozechner/pi-tui` for the text field.

**Keyboard modes:**

- **Navigation mode (default):** Number keys 1-9 instantly submit. Arrow keys move highlight. Tab enters text mode on the highlighted option. Enter submits highlighted option. Escape cancels.
- **Text mode:** All keys route to `Input`. Enter submits selection + annotation. Escape exits text mode (clears text, back to navigation). Arrow up/down exits text mode (clears text, moves highlight).
