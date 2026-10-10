# DR-057: Quota blocks fail at the provider seam as non-retryable errors

## Status
Accepted

> Supersedes DR-040 (Quota enforcement returns `handled` and notifies rather than throwing from the input handler), deleted at commit `4a9209ae6d8119848f5e2d8242e4bff7e97bedd1`.

## Context
DR-040 enforced quota blocks in the `input` handler with `{ action: "handled" }` plus an error-level notify. That choice came from a pi fact that remains true: the extension runner silently discards throws from `input` handlers, so throwing cannot block a prompt. The pattern kept blocked prompts out of session history but destroyed the submitted message. Pi clears the editor at submit, and a `handled` prompt never reaches the transcript, so the text was unrecoverable. A real provider error preserves the message as a failed turn, and users expected that behavior.

Separately, pi-ai classifies retryability purely by pattern-matching the error text, and its non-retryable quota and billing patterns win over anything else. There is no first-class retryable flag.

## Decision
Quota enforcement moves entirely to the `streamSimple` guard. The guard throws the block text before the provider is invoked, so a blocked prompt fails exactly like a provider error: pi appends the message, the failed turn keeps it visible, and nothing is lost. The `input` handler only refreshes usage and the status line. Block wording stays free of retriable indicators ("quota hard cap exceeded..."), so pi-ai's classifier fails fast with no auto-retry and no retry affordance.

Rejected alternative: keep the fast path and restore the editor via `ctx.ui.setEditorText(event.text)`. It preserves the text but still omits the transcript entry, so it never matches provider-error UX and adds a second presentation path to maintain.

## Consequences
Blocked attempts now append the user message to session history. Repeat attempts accumulate transcript and context until the cap resets or bypass turns on. In RPC mode children settle through the generic `agent_end` error path, so DR-041's pre-agent-start notify detection remains for other extensions only. The non-retryable guarantee lives in message wording, not code: future edits to block text must avoid retriable patterns (rate limits, status codes) or blocks will start auto-retrying.
