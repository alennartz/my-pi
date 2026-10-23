---
name: tool-design
description: "Design, write, or review the prompt text of a pi tool: promptSnippet, promptGuidelines, description, and parameter descriptions. Use when registering a pi tool with registerTool or registerLooseTool, when editing tool text, when auditing tool prompts for duplication or misplaced content, or when another skill needs the field rules."
---

# Tool Design

## Overview

A tool's text reaches the model in two places. The **planner** reads the system prompt. The **caller** reads the tool schema. Put each fact in the field that matches its reader. A fact in the wrong field costs tokens every turn, or it fails to guide the caller.

## Pi mechanics

Verified against the pi source at v0.15.0-rc.5. Recheck after a pi upgrade.

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
- Write one sentence. Put the condition first: `As a subagent, do not use send to report a final result.`
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

## Generated tools

When a tool's text comes from upstream, such as an MCP server, derive the snippet by rule. Do not copy the description. The `toolscript_*` rule: the first sentence, capped at 15 words, with the registered tool name as fallback when the upstream description is empty.

## Failure modes

- **Manual in the snippet.** The snippet lists arguments or return fields. Move them to the description.
- **Advice in the description.** Phrases such as "Useful for" or "Use when" belong in a guideline.
- **Restated sentence.** The same sentence appears in two fields. Keep one copy.
- **Cross-tool rule on one tool.** A routing rule sits in one tool's description. Move it to a guideline that names both tools.
- **Negation.** A `Do NOT` line in a description. Rewrite it as the positive rule in the right field.

## Review checklist

1. Each registered tool has a one-line snippet with purpose only.
2. Each guideline names its tool, states a routing or ordering rule, and holds no mechanics.
3. Each description states behavior, return shape, and limits, with no advice.
4. No fact appears in two fields.
5. Every hard limit enforced in `execute` appears in the description.
6. Parameter descriptions carry meaning only.
7. Generated tools derive their snippets by the stated rule.
