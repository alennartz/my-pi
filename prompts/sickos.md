---
description: Run all three Sicko reviewers concurrently on one scope
argument-hint: "[scope override]"
---
Run Comment Sicko, Spaghetti Sicko, and Test Sicko concurrently as independent reviewers.

The optional scope override is:

<scope-override>
$ARGUMENTS
</scope-override>

If the block contains non-whitespace text, forward its exact contents as `Scope override` in each Sicko's task. Do not paraphrase or alter it. If the block is empty, omit the `Scope override` field from every task. Let each persona use its normal default scope.

Use one `subagent` call with three agents and `await: true`. Do not spawn them sequentially. Spawn these exact personas with distinct ids: `comment-sicko`, `spaghetti-sicko`, and `test-sicko`. Use no peer channels or model overrides. Give each a task to review its own Sicko remit, return its report, and make no edits. Append the same scope override to all three tasks only when supplied.

After all three return, report each result under its Sicko name. Preserve every `MUST KILL` flag. Note overlapping findings without counting them twice. Report any agent failure instead of implying full coverage. Do not edit code or resolve the findings.
