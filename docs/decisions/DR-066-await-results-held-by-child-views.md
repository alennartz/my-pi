# DR-066: Await Results Are Held by Open Child Views

## Status
Accepted

## Context
Pimote presents live child runtimes through borrowed views. A child can settle while its view is open, but delivering that idle result immediately would remove the result from the view's completion state and could make the parent continue before the user finishes inspecting it. DR-025 required every child completion to resolve `await_agents` once the requested children settled.

Supersedes DR-025 (Await as Standalone Tool with Asymmetric Interrupt Semantics), deleted at commit `b5a9be41515fd826e47d6ce0604d69bf8e082925`.

## Decision
Keep `await_agents` as a standalone tool, and keep messages as immediate interruptions. When a Pimote child-view lease is active, hold that child's latest settled idle result and keep the await pending. A later idle result replaces an earlier held result. The final lease release delivers the latest result and allows the await to resolve when all requested children have settled. Without a view, completion resolves the await normally.

Parent Stop discards held results and releases the wait. Child Stop records a stopped outcome without an unsolicited idle notification or a held view result. A child starting another run clears its previous settled marker and held result. Lease state stays in my-pi's turn coordinator and is not exposed in transcript text.

## Consequences
Users can inspect a settled child before its result reaches the parent, without a second runtime or a second journal. Open views can keep an await pending longer, and the turn coordinator must release or discard held results during lease and session shutdown. Message interruptions remain immediate, so a parent can respond while a child view stays open. The provider owns lease lifecycle callbacks, while ordinary manager teardown and runtime ownership stay in my-pi.
