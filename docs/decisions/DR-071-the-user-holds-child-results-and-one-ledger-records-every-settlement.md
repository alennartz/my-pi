# DR-071: The User Holds Child Results, and One Ledger Records Every Settlement

## Status
Accepted

## Context
Supersedes DR-067 (A Viewed Child's Stop Holds the Parent's Wait), deleted at commit `31e340b15ae858fad81632edaffb78b0b20be1c1`, and DR-068 (A Replaced Held Answer Tells the Parent to Ask Again), deleted at commit `af08be9d2add2e8a57efbe88c405e51ed891a433`.

DR-066 and DR-067 held a child's settled result while a Pimote view leased the child. DR-089 in Pimote later made leases follow observers, profile reattach, every device, and every user. A lease no longer meant that a person was watching. The 27 November 2026 audit traced hung waits, lost answers, and false "completed" reports to this rule (C2, H12, H13, H15, M18, L14).

Four copies of each settlement existed: the await gate, the registry, the queue text, and a stored status map. The await result read only the registry and the queue, so stopped, removed, and held outcomes never reached the model. Settlements arrived only from completion events and lease callbacks, so a removal without a view never settled a wait. A parent Stop rebuilt the gate and dropped every held answer.

## Decision
A hold is a per-child flag that only the user sets, through the provider's `setHold({ path, incarnation, held })`. Views and leases never affect orchestration. The flag and the undelivered settlements persist in the manager's lifecycle log, so a release after restore delivers what the parent has not received and nothing it already has.

Each manager owns one settlement ledger, keyed by path and incarnation. Every child run start, settlement, hold change, removal, and wait goes through it:
- A held child's settlements reach no one. The await card shows it as `held` and the wait does not count it as settled. Explicit messages still flow.
- A release delivers through the active wait or a notice.
- A new run discards undelivered answers and marks the next delivery as a replacement. Stops keep the mark. A `dead` settlement without a new run does not displace an answer; both are delivered.
- A removal settles the child as `removed` in the active wait, with or without a view, and the removal result carries any held output.
- A parent Stop cancels the wait. Undelivered settlements go out as notices and park per DR-072.
- The model-facing await text comes from the per-child outcomes, so stopped, removed, and held children are named.

Waits key on incarnations, which are UUIDs, so a later child at the same path cannot satisfy a wait for a removed one.

The ledger saves each pending settlement with a stable receipt ID before it offers the answer. An await result or notice names only IDs represented in its model-facing text. The ledger removes an offer when the owning parent's selected transcript branch contains those IDs. On restore, the same check detects an answer committed before ledger cleanup. IDs survive retries, and each child's pending answers and replacement notes keep their order.

Rejected: acknowledge a result when the extension calls `sendMessage` or returns from a tool. Pi can defer the append, so a process exit in between loses the answer. Rejected: acknowledge only in the lifecycle log. A process exit after the transcript append but before the log write would then duplicate the answer. An ancestor's teardown report previews nested answers without acknowledging them to their original parents.

Rejected: remove the hold entirely and let `await_agents` resolve when children settle. A person who wants to steer a child first would have to stop the parent or race it.

Rejected: keep the lease-based hold and patch it with a time limit, a dead exemption, and "held by view" text. The behavior would still depend on socket and profile state that neither the user nor the model can see.

## Consequences
A held child blocks a default `await_agents` until the user releases it. The panel and the await card show the hold, so the cause is visible, but a forgotten hold still stalls the parent.

The replacement note still states a possibility, not a certainty: a child can finish twice, and the parent decides whether to ask again.

The lifecycle log holds the pending answers until the parent commits them. Restore preserves the order within each child, not a total order across children. The selected branch decides which pending receipts count. Switching branches does not resurrect settlements after cleanup. The protocol covers process exit between writes, not loss of data on power failure.

Persisted holds add an `agent_hold` record to the lifecycle log. A log written before this change has no holds, and restores as unheld.
