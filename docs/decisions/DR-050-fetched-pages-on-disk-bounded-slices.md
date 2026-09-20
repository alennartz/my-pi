# DR-050: Fetched pages live in full on disk; the model sees bounded slices

## Status
Accepted

## Context
Fetching a long page dumps tens of thousands of tokens into context. The survey (`docs/research/web-search-landscape.md`) found two dominant remedies: spill to a temp file the agent reads via `read` (pi-web-extension, Aider), or serve bounded slices from stored content with targeted retrieval (pi-web-access, MCP Fetch's `max_length`/`start_index`, Jina token budgets). Day-1 requirements also included `findText` passage search and restart-surviving caches.

## Decision
The disk store (`~/.pi/agent/web-tools/cache/`) is the source of truth: every successful fetch stores the full untruncated markdown (atomic write, 24h lazy TTL, mtime-pruned at 1000 entries). The tool returns bounded slices — `maxCharacters` + `offset` continuation, or `findText` matched passages — both served from the store, so pagination and passage search never refetch, and both work across sessions. Rejected: temp-file spill (forces the model through `read` chunking for everything, no in-tool retrieval); inline-only output (long pages blow the context budget and any re-read refetches).

## Consequences
One network fetch serves many reads; restarts preserve pages; token cost per read is explicit and capped. Cost: a growing on-disk cache under the pi agent dir (bounded but real), 24h staleness by default (`fresh` bypasses), and cache keyed by URL, so content changes before TTL expiry are invisible to continuation reads.
