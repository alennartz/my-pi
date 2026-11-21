# DR-067: A Viewed Child's Stop Holds the Parent's Wait

## Status
Accepted

## Context
DR-066 held a child's settled result while a view was open, but exempted a stop. A stopped child released `await_agents` at once and discarded any held result.

While a parent waits, only a person watching the child can stop it. Pressing Abort in the child view therefore woke the parent's wait in the middle of an inspection. The parent's next turn ran against a child the person was still reading and about to steer, and the held result was gone.

An abort ends one run, not the child. The session stays live and can be prompted again. Awaiting the end of that run is not the same as hearing that the child finished.

## Decision
A stop settles the child in the await gate like any other result. While a lease is attached the settlement is held, and the last detach releases the wait. The release carries the child's stopped outcome and delivers no idle notification, because a stop is not a completion. Without a view, a stop resolves the wait immediately, as before.

Parent Stop still discards held results and releases the wait: that stop ends the session that owns the wait.

Rejected: settle a viewed stop as idle. The parent would read an aborted run as a finished task.

Rejected: keep the immediate release and let the parent read the stopped outcome. The wait itself must not fire, and a status the parent sees after it has already continued cannot protect the view.

## Consequences
A person who aborts a child and keeps the view open also keeps the parent waiting. A forgotten view holds the wait for as long as it holds the lease that already gates idle results, so the stop path adds no new way to leak a wait.

The provider's `stop` seam now only ends a run. Teardown, resurrection, error, and dead settlements keep their existing handling.

The child's next run clears the held stop, exactly as it clears a held idle result.

Supersedes DR-066 (Await Results Are Held by Open Child Views), deleted at commit `15c00ac84ce630dd9961fe8bcc7636706a49fac0`.
