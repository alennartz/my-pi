# DR-048: Web access ships as typed extension tools, not shell-skill scripts

## Status
Accepted

## Context
The brave-search skill (shell scripts invoked via bash) was the package's web capability. The landscape research (`docs/research/web-search-landscape.md`) showed every strong harness exposes web access as a typed tool, and our scripts had no schema validation, no abort propagation, unstructured text output the model had to re-parse, and no seam for caching, policy, or retries.

## Decision
Web access lives in `extensions/web-tools/` as `web_search`/`web_fetch` registered via `pi.registerTool`. Rejected alternatives: hardening the shell scripts — keeps subprocess overhead, shell-quoting risks, and still no schema/abort/structured details; an MCP server — pi has no built-in MCP client, so we would still need an extension to bridge it, gaining nothing at this layer. Dependencies stay at the package root, matching the sibling-extension convention (subagents, quota-providers declare no deps in their manifests).

## Consequences
Params are validated, abort signals reach HTTP calls, and `details` carries structured results for future phases (reranking, evidence ledgers). Cost: the tools are model-callable only — no ad-hoc CLI use like the old scripts (`extensions/web-tools/smoke.ts` covers manual verification), and the extension now owns pipeline complexity the scripts never had.
