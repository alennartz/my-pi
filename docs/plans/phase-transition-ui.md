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

## Steps

**Pre-implementation commit:** `d2164fa95b19cc96e5b5aa923458448ada3e46bb`

### Step 1: Create `lib/components/numbered-select.ts` — the component

Create `lib/components/numbered-select.ts` with the `showNumberedSelect` function. This is the bulk of the work:

- Export `NumberedSelectOption`, `NumberedSelectResult` interfaces and the `showNumberedSelect` async function.
- The function validates inputs (empty options → throw, >9 options → throw), then calls `ctx.ui.custom()` with a component that manages two keyboard modes.
- **Rendering:** Title line, then numbered options (`1. Label` / `2. Label`), highlighted option gets accent color and `>` prefix. When in text mode, the `Input` component renders inline after the highlighted option. Help text at the bottom shows available keys. Accent-colored `─` border lines top and bottom.
- **Navigation mode input:** digit keys 1-N instantly call `done()` with that option. Up/down move highlight. Tab switches to text mode (creates/focuses `Input`). Enter submits highlighted option. Escape calls `done(undefined)`.
- **Text mode input:** all keys route to `Input.handleInput()`. Enter calls `done()` with the highlighted option + `Input.getValue()` as annotation (trimmed, `undefined` if empty). Escape clears input and exits text mode. Up/down clear input, exit text mode, move highlight.

**Verify:** File exists at `lib/components/numbered-select.ts`, exports the function and types. Manual test: import from a scratch extension, call `showNumberedSelect` with 3 options, verify number keys submit instantly, arrow+tab+type+enter submits with annotation, escape cancels.
**Status:** done

### Step 2: Integrate into `workflow_phase_complete` — replace `ctx.ui.select()` calls

In `extensions/workflow/index.ts`:

- Add import: `import { showNumberedSelect } from "../../lib/components/numbered-select.ts";`
- Replace the flexible transition `ctx.ui.select()` block with a call to `showNumberedSelect(ctx, title, options)`. Map the result: `undefined` or index matching "No, not done yet" → return `NOT_DONE_TEXT`; index matching "Yes, in this context" → return continue text; index matching "Yes, in a new context" → set `pendingTransition`, return `STOP_TEXT`.
- Replace the mandatory transition `ctx.ui.select()` block the same way.
- When `result.annotation` is present, append `" User's note: <annotation>"` to the tool result text for all paths. For the `NOT_DONE_TEXT` path this means the agent immediately knows what's unfinished. For the "yes" paths, the annotation carries forward as context for the next phase.

**Verify:** Run a workflow through a phase transition. Verify: number key instant-selects work, arrow+enter works without annotation, tab+type+enter includes the annotation in the tool result the LLM sees, escape cancels. Check both flexible (brainstorm→architect) and mandatory (plan→implement) transitions.
**Status:** not started
