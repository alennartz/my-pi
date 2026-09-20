# DR-049: The web pipeline is deterministic-first; ML-assisted layers come later and sit on top

## Status
Accepted

## Context
During research we evaluated PyScrappy (full-auto extraction) empirically and surveyed providers where ranking, extraction, and synthesis are all model-driven. Our own measurements showed deterministic Readability/Turndown beating PyScrappy's extraction on real pages (title-only output on React docs and Wikipedia; broken inline spacing), and the landscape report (`docs/research/web-search-landscape.md`) concluded ML belongs in selection and synthesis, not in basic fetching and safety.

## Decision
`web_search`/`web_fetch` contain no model calls — URL policy, redirects, retries, extraction, caching, slicing, and passage search are all deterministic. Provenance-bearing result types (`FetchResult` with `contentHash`, `attempts`, `fromCache`, `effectiveUrl`) are the contract future ML layers consume. Reranking, query planning, and synthesis are deferred to a later `web_research` layer built on these primitives. Rejected: adopting an all-in-one ML library or hosted provider as the pipeline (PyScrappy's extraction measurably underperformed; hosted-everything forfeits control over policy and provenance).

## Consequences
Ordinary searches are fast, cheap, reproducible, and debuggable; safety behavior never depends on a model. Cost: no query-aware highlighting or semantic dedupe yet — a long page hunt costs multiple offset calls until `web_research` exists.
