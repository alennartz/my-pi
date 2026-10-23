---
name: tool-design
description: "Design, write, or review a pi tool. Use when registering a pi tool with registerTool, when editing tool text, when auditing tool design reviewing it's implementation."
---

# Tool Design

## Overview

A tool's text reaches the model in two places. The **planner** reads the system prompt. The **caller** reads the tool schema. Put each fact in the field that matches its reader.

## Pi mechanics

- `promptSnippet` appears in the system prompt under `Available tools:`. Pi collapses it to one line and does not truncate it.
- A tool with no `promptSnippet` does not appear under `Available tools:`.
- `promptGuidelines` from every tool merge into one flat `Rules` list. Each guideline must name its tool.
- `description` goes into the tool schema. The caller reads it when it forms arguments and interprets results.

## Field roles

| Field | Reader | Holds | Does not hold |
|---|---|---|---|
| `promptSnippet` | Planner | Purpose and selection cue, one line | Arguments, return shape, inheritance, numbers |
| `promptGuidelines` | Planner | Cross-tool routing and ordering rules | One tool's mechanics |
| `description` | Caller | Behavior, return shape, side effects, limits | Advice on when to use the tool |
| Parameter `description` | Caller | Meaning, allowed values, defaults of one argument | Policy about when to omit it |

## Rules

### promptSnippet

- Write one line of 5 to 15 words.
- State what the tool is for and when to pick it over alternatives.
- Do not restate the tool name. Pi already lists it.
- Do not list arguments, return fields, or inheritance rules.
- Set one for every tool. Without it, the planner does not see the tool.

### promptGuidelines

- Write a guideline only for a routing or ordering rule that spans tools or sets a default across tools.
- Name the tool in every guideline.
- Write one sentence. Put the condition first: `Before you edit a file, read it.`
- Use no guideline when the tool has no routing rule. An empty list is correct.

### description

- Write one to three sentences.
- State what happens, what returns, side effects, and limits.
- Name the return fields the caller must anticipate.
- State hard limits that the schema cannot express. Example: a title length enforced only in `execute`.
- Omit advice, workflow, and prohibitions. Move them to guidelines in positive form.

### Parameter descriptions

- Write the meaning, allowed values, and default.
- Move policy about when to omit a parameter to a guideline.
- Keep each to one sentence where possible.

## One fact, one field

A fact appears in exactly one field. Test each sentence: does the reader of this field need it? If the planner needs it, keep it in the snippet or a guideline. If the caller needs it, keep it in the description or the parameter. Delete the copy in the other field.

A sentence repeated across two fields is a defect even when both copies are accurate. Duplicates cost tokens on every turn and drift apart over time.

## Codemode

Codemode is a built-in tool. It runs a JavaScript script that calls other tools. The script can call several tools at once. Only the script's output reaches the model.

The **codemode catalog** is the list of callable-tool declarations that Pi inserts into the `codemode` tool's own description. It helps the model write a script. It is not the set of tools a script can call. A callable tool can be absent from the catalog and still be callable. When codemode is active in mode `on`, direct tools are omitted from the catalog because their normal declarations carry a codemode call note. Scripts can still call those tools and can discover them with `ALL_TOOLS`, `searchTools()`, and `describeTool()`.

What a tool must do so that scripts can use it:

- Exposure controls whether a script can call the tool. A `direct` tool is callable from codemode while it is active.
- Declare `outputSchema` when scripts need structured data. A script then receives `structuredContent`. Without `outputSchema`, a script receives the text content. `outputSchema` controls the result shape, not callability.
- Put the full payload in the field the schema declares. The model still receives `content`.
- To report a failure that still carries data, return `isError: true`. Do not throw. The model sees the error, and the script still receives `structuredContent`.
- Make the tool `model-only` when it asks the user or orchestrates other tools. A script cannot answer a UI prompt. The Exposure section defines what each value allows.

Settings (`codemode.mode`):

- `on` (default): active direct tools remain in the model's normal tool list, and their descriptions explain the `tools.<name>(args)` call. The codemode catalog lists only callable tools that are not direct. This omits direct tools from the catalog, not from codemode access.
- `only`: the codemode catalog lists every callable tool. Pi hides active direct-tool declarations from the model's normal tool list, but scripts can still call those tools.

Restricted sessions:

- A restricted tool list pins the exact tool set. Include `codemode` and every tool a script must call. Codemode cannot call a tool outside that set.
- Granting codemode also grants the `models` global. That global spends credentials on classifier and image models.
- A child agent can run with fewer tools than its parent. Check the child's list when a tool must not run there.

## Exposure

Exposure separates the model's normal tool list from codemode script access. Catalog inclusion is a separate presentation choice controlled by `codemode.mode`. Set exposure on every tool. Verified against pi 1.4.0 docs and type declarations.

Three terms:

- **Declared:** the model sees the tool in its normal tool list while the tool is active.
- **Callable:** a codemode script can call the tool as `tools.<name>(args)`.
- **Catalog-listed:** the tool's declaration appears in the codemode catalog. A tool can be callable without being catalog-listed.

All rows are subject to the session's tool allowlist.

| Exposure | Declared to model | Callable from codemode | Catalog in mode `on` | Catalog in mode `only` | Active on registration |
|---|---|---|---|---|---|
| `direct` (default) | Yes, while active | Yes, while active | No. Its normal declaration carries the codemode call note. | Yes, while active | Yes |
| `model-only` | Yes, while active | No | No | No | Yes |
| `codemode` | No, unless activated | Yes, whenever registered | Yes | Yes | No |
| `deferred` | No, until `tool_search` loads it | Yes, whenever registered | No. `tool_search` can find it. | No. `tool_search` can find it. | No |
| `hidden` | No | No | No | No | No |

- Use `direct` for a tool that the normal LLM interface and codemode scripts must both use. In mode `on`, its absence from the codemode catalog is intentional and does not block calls.
- `model-only` tools are declared but never callable. They ask the user or orchestrate other tools.
- `codemode` tools are callable and catalog-listed, but the model sees them only after activation.
- `deferred` tools are callable but not catalog-listed. `tool_search` can find and activate a match, so the model can declare the tool for its next call.
- `hidden` tools cannot be reached at all. Tools cannot be unregistered, so re-register a tool with `hidden` to withdraw it.

Other meta fields:

| Field | Values | Default | Effect |
|---|---|---|---|
| `defaultActive` | `true` or `false` | `true` for `direct` and `model-only`. Other exposures never activate on registration. | `false` keeps the tool inactive until `--tools`, the `defaultTools` setting, or `setActiveTools()` names it. |
| `executionMode` | `sequential` or `parallel` | Omitted means the default execution mode applies. | `sequential` for a tool that shares mutable state with other calls. |
| `namespace` | `{ name, aliases, description, instructions }` | None | Groups related tools, such as an MCP server. Scripts read `instructions` through `describeNamespace(name)`. The model does not see them. |
| `annotations` | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` | Missing hints take the MCP defaults. | Author hints, not verified. Permission extensions use them to confirm calls. |
| `reachesTools` | Function returning `"all"` or a list of words | None | For a tool that calls other tools. Declares which tools a call may reach. |
| `prepareLoadout` | Function returning changes to the declarations | None | For a tool that orchestrates others. Adjusts what the model sees while the tool is active. |


## Result truncation

Bound the text the model reads. Bound it once, where the result is built.

- Prefer pi's exported helpers. Use `truncateHead` for content read from the start, such as file reads. Use `truncateTail` for output where the end matters, such as command output and errors.
- Pass `maxLines` and `maxBytes` when a tool needs a bound other than pi's defaults: 2000 lines and 50 KB.
- Use middle truncation only when both ends matter and no exported helper fits. Pi does not export one. Keep the start and the end, and mark the removed middle with its size.
- When you write your own cut, cut only at character boundaries. A byte cut can split a multi-byte character.
- When the output is truncated, save the complete text to a file and name the path, size & line count in the result. 
- If saving fails, return the bounded text and say the full output is unavailable. Do not fail the call.
- For paged results, return a `truncated` flag and the next offset. An offset past the end returns a message, not an error.
- Leave structured output unbounded when codemode scripts read it. Scripts need the full result.

## Interruption and cancellation

- Accept the abort signal in `execute`. Check `signal.aborted` before starting work. On abort, reject with a named error.
- Attach each abort listener with `{ once: true }`. Remove it on every exit path.
- In a retry loop, stop retrying once the signal aborts.
- Bound every wait with a timeout. A wait on work that may ignore its signal returns an outcome such as "settled" or "pending". It never waits without a limit.
- Make repeated cancels idempotent. A cancel on a finished target returns at once.
- Report what is still running in the result, so the caller can tell finished from pending.
- A user dismissal is a normal result with a flag, such as `"cancelled": true`. Throw only for invalid use, such as a missing UI.
- Decide per event type which events end a wait. Some events accumulate. Others, such as a message that needs a reply, end the wait at once.
- Do not start a new turn from messages queued during an aborted run. Hold them for the next turn.

## Parameter defaults

- Declare limits in the schema: minimum, maximum, and minimum and maximum item counts. Validation rejects out-of-range input before the tool runs.
- State each default in the description, such as "default 8000". The model learns the omitted behavior from the text.
- Apply the default in code. Clamp the value to the absolute maximum, so a caller that skips validation still gets a bound.
- For an optional parameter, treat its type default the same as omission whenever the semantics allow. An empty string on an optional string should have the same effect as leaving it out. Apply the same rule to an empty array or an empty object.
- Some models send these empty values instead of omitting the parameter. Normalize them in `prepareArguments`, before validation.
- Check each case before you normalize. Keep the value when it carries meaning. A boolean that defaults to true must keep `false`. A numeric zero can be a real value.
- Required parameters keep their values. An empty string can be meaningful there, for example a value that clears a setting.
- Rename legacy field names in `prepareArguments` before the cleanup step and validation.