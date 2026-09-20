# Web-search tools for coding harnesses: landscape report

**Research snapshot:** 2026-09-18  
**Scope:** coding-agent harnesses, web-search/fetch providers, browser and extraction pipelines, context/token control, caching, provenance, and security.  
**Status:** research only. This report does not choose an implementation yet.

## Executive summary

There is no single "web search tool" design. The mature systems separate several jobs:

1. **Discovery** — search for candidate sources and return compact result cards.
2. **Retrieval** — fetch a known URL or document.
3. **Rendering** — execute JavaScript or use a browser when static retrieval is insufficient.
4. **Extraction** — turn HTML/PDF/browser output into readable, structured content.
5. **Selection** — deduplicate, rerank, diversify, and choose evidence.
6. **Context delivery** — page or filter content so the model sees only what it needs.
7. **Provenance** — retain source identity, retrieval state, content hashes, and exact citation spans.
8. **Policy and operations** — enforce SSRF/robots/privacy rules, retries, budgets, caching, and partial-failure behavior.

The strongest common pattern is:

```text
plan → bounded search → canonicalize/dedupe → rerank → selective fetch
     → quality check → optional reader/browser fallback → extract/chunk
     → evidence ledger → bounded model output → citation validation
```

The most important design lesson is **progressive disclosure**. Search results should be cheap cards. Full pages should be fetched only for selected URLs. Large pages should be stored and paged or filtered rather than inserted wholesale into the model context.

For `my-pi`, the best starting point is not a 19-provider aggregator or a mandatory browser. It is a small native Node pipeline that keeps the current Readability/Turndown extraction, adds a typed seam around it, and makes fallback providers, browser rendering, and research planning optional layers.

## 1. What counts as a coding-harness web tool?

| Layer | Question it answers | Typical output |
|---|---|---|
| Search/discovery | Which pages might answer this? | URL, title, snippet/highlight, rank, date, provider metadata |
| Fetch/read | What does this known page say? | Markdown/text/HTML, title, status, retrieval metadata |
| Browser/render | What appears after scripts, cookies, scrolling, or interaction? | Rendered DOM, links, screenshots, browser state |
| Extraction | Which part is the page's actual content? | Article body, headings, tables, links, metadata |
| Research orchestration | What should be searched/fetched next? | Subqueries, selected sources, synthesis, stop condition |
| Evidence/provenance | Which source supports which statement? | Source IDs, chunk IDs, offsets, hashes, citations |
| Context management | How much should enter the model? | Preview, highlights, chunks, pages, bounded excerpts |

MCP standardizes tool discovery and JSON-Schema calls, but it does **not** standardize search ranking, page extraction, provenance, citation rendering, caching, or safety. Those remain host/provider responsibilities. Source: [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

## 2. Coding-harness landscape

### 2.1 First-party and major coding agents

| Harness | Search/fetch shape | Notable design | Caveats |
|---|---|---|---|
| **Pi** | Upstream Pi has no built-in web search/fetch tool. The installed Brave capability is a skill with shell scripts (`search.js`, `content.js`). Extensions can register typed tools. | Very small, transparent, easy to customize. | The skill has no standard citation contract, source ledger, cache, URL policy, retry policy, or browser escalation. |
| **Claude Code** | Native `WebSearch` and `WebFetch`. Search discovers; fetch reads a supplied URL or a URL from prior search context. | Separate limits, domain controls, fetch content-token caps, cache controls, URL provenance validation, and newer dynamic filtering that runs code before content reaches context. Search citations are first-class; fetch citations are opt-in. | Provider-owned retrieval and pricing. Search/fetch behavior is not a local implementation. Sources: [Web Search](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool), [Web Fetch](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-fetch-tool). |
| **OpenAI Codex CLI / Responses** | Hosted `web_search` with cached, indexed, live, or disabled modes in Codex. Responses actions include search, open-page, and find-in-page. | Domain filters, location, source lists, context-size controls, token-budget control, and URL citation annotations. Cached/indexed modes provide a safer and cheaper default than arbitrary live access. | Provider owns retrieval and citation behavior. Source: [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search), [Codex web search](https://developers.openai.com/codex/web-search). |
| **Gemini CLI / Gemini API** | Separate `google_web_search` and `web_fetch`; URL Context is a provider-native fetch/synthesis path. | Grounding metadata becomes numbered citations. Fetch can accept multiple URLs, validates resolved addresses against private/reserved ranges, and has a separate optional browser agent. | Search/fetch normally involve Gemini synthesis, not just raw page delivery. Sources: [Gemini CLI web search](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/web-search.md), [web fetch](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/web-fetch.md), [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search). |
| **Cursor** | Agent includes web search, web fetch permissions, and an integrated browser that can navigate, interact, screenshot, inspect console/network state. | Browser is a separate capability from ordinary search/fetch and is permission-controlled. | Closed implementation: public docs do not specify backend, extraction schema, or formal citation contract. Sources: [Agent overview](https://cursor.com/docs/agent/overview), [browser tool](https://cursor.com/docs/agent/tools/browser). |
| **Cline** | Native `fetch_web_content`; web search is generally provider-native or plugin-provided (Exa is a common plugin). Browser automation is separate. | Fetch has a simple `{requests: [{url, prompt}]}` shape, timeout/size bounds, HTML-to-text conversion, and permissions. | No universal source/citation model; behavior changes with provider/model. Sources: [Cline tools](https://docs.cline.bot/tools-reference/all-cline-tools), [Exa plugin](https://github.com/cline/cline/blob/main/sdk/examples/plugins/web-search.ts). |
| **Roo Code** | Mostly provider-native Google Search Grounding/URL Context. Grounding events carry source title/URL/snippet. | Typed grounding events and citation links in supported flows. | No single Roo-owned search/fetch abstraction; browser action was removed in favor of Playwright/MCP integrations. Sources: [Gemini provider docs](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/docs/docs/providers/gemini.md), [grounding implementation](https://github.com/RooCodeInc/Roo-Code/blob/main/src/api/providers/gemini.ts). |
| **Aider** | `/web <url>` scrapes a user-supplied page. It uses HTTP by default and optionally Playwright for JS-heavy pages. | Deliberately simple context injection; URL is visible in chat. | It is page scraping, not a first-class search/research API. No documented structured citation contract. Sources: [Aider URL docs](https://aider.chat/docs/usage/images-urls.html), [scraper source](https://github.com/Aider-AI/aider/blob/main/aider/scrape.py). |
| **Continue** | Native `search_web` plus `fetch_url_content`. Search returns five hosted results; fetch uses Mozilla Readability and Markdown conversion. | Clear discovery/read split, read-only tool permissions, URL provenance in context items, hard output caps (search 8k chars, fetch 20k). | Hosted search backend is opaque and final citations are not mandatory. Sources: [search definition](https://github.com/continuedev/continue/blob/main/core/tools/definitions/searchWeb.ts), [fetch definition](https://github.com/continuedev/continue/blob/main/core/tools/definitions/fetchUrlContent.ts), [URL provider](https://github.com/continuedev/continue/blob/main/core/context/providers/URLContextProvider.ts). |
| **OpenCode** | Native `websearch` via Exa/Parallel and native `webfetch` via direct HTTP. | Separate permissions for query and URL; fetch supports text/Markdown/HTML, timeout, and 5 MB bounds. | No documented formal citation ledger. Search is hosted/no-key through its backend. Sources: [tools](https://opencode.ai/docs/tools/), [permissions](https://opencode.ai/docs/permissions/). |
| **Goose** | A built-in `web-search` skill uses `uvx ddgs`, Tavily, or SearXNG; pages are fetched with `curl`/`html2text`. Richer capabilities come from MCP extensions. | Explicit robots/auth-cookie guidance and bounded head/tail output. | Skill-level contracts, not typed provenance/citations. Sources: [skill docs](https://block.github.io/goose/docs/guides/context-engineering/using-skills/), [skill source](https://github.com/block/goose/blob/main/crates/goose/src/skills/builtins/web_search.md). |
| **GitHub Copilot CLI** | Configurable web search, URL fetch, and a `/research` agent spanning code/GitHub/web. | Approval-gated URL access and integration with CLI sandbox/network policy. | Backend and citation schema are not fully public. Sources: [IDE web search](https://docs.github.com/en/copilot/using-github-copilot/copilot-chat/asking-github-copilot-questions-in-your-ide), [CLI research](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/research). |

### 2.2 Pi ecosystem implementations

These are especially relevant because they are designed for Pi rather than general API clients.

| Package | Design worth studying |
|---|---|
| [`pi-web-extension`](https://github.com/NicoAvanzDev/pi-web-extension) | Keyless Brave search with DuckDuckGo fallback; `webfetch` converts HTML to Markdown, writes a temp file, and returns only metadata/preview so the agent reads the file in chunks. It also steers prompts when a URL/search intent is detected and trims oversized pages. |
| [`pi-search-hub`](https://github.com/ronnieops/pi-search-hub) | One `web_search` and one `web_read` over 19 providers. Sequential fallback or parallel combine mode. Combine uses Reciprocal Rank Fusion (RRF, `k=60`), normalized-URL dedupe, richest-content preference, backend stats, and provider labels. Reader fallback distinguishes transient/no-content failures from fatal 401/403 errors. It also has LRU/TTL search cache, SSRF protection, credential resolution from env/shell/literal, and cooldowns. |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | Broad provider routing plus `fetch_content`, `get_search_content`, and `source_check`. It stores full page content outside the session transcript, supports offset/find-text retrieval, GitHub cloning, PDF/video special cases, exact passage offsets, content hashes, and machine-readable research artifacts. Hosted fetch is explicitly opt-in because the remote provider performs its own network/redirect/DNS work. |
| [`pi-web-toolkit`](https://github.com/Wade11s/pi-web-toolkit) | Local-first SearXNG + Scrapling, bounded parallel batch fetch, agent-browser for interaction, and optional Firecrawl keyless fallback. It has shared extraction/preview/output-sink utilities and an installer/doctor workflow, but requires Node 22, `uv`, SearXNG, Scrapling, and agent-browser. |
| [`pi-read-page`](https://github.com/Sukitly/pi-read-page) | Read-only local Chrome rendering, network-idle wait, lazy-load scrolling, shadow-root flattening, Defuddle extraction, confidence/handoff detection, 30-day cache, line pagination, stale fallback, and manual login/CAPTCHA handoff. Blocks private networks by default. |
| [`pi-browser-search`](https://github.com/sebaxzero/pi-browser-search) | Chromium-backed search/open/read/action tools. Search is static DDG so the browser is reserved for pages that need rendering. Uses output sanitization, random delimiters, prompt-injection pattern redaction, and network-layer SSRF checks for every browser subrequest. |
| [`pi-web-search-and-fetch`](https://github.com/xinaps-dev/pi-web-search-and-fetch) | Clean provider seams: `SearchProvider`, `FetchProvider`, optional `DeepSearchProvider`; canonical search/fetch result types; batch fetch; `maxCharacters`; abort signals; untrusted-content envelopes; and provider registry. This is an excellent small core contract. |
| [`@upstash/context7-pi`](https://github.com/upstash/context7/tree/master/packages/pi) | Documentation retrieval rather than general web search. Resolves a library ID, then queries focused current docs/code. Useful as a specialized provider rather than part of general web search. |

## 3. Provider and service landscape

| Provider/service | Search | Fetch/extract | Clever features | Trade-offs |
|---|---|---|---|---|
| **Brave Search API** | Web, news, images, video, local, freshness, country/language, safe search, result filters, extra snippets. | No general URL-fetch endpoint. Brave LLM Context returns pre-extracted relevance-ranked snippets and source metadata. | `brave_llm_context` and summarizer can supply AI-grounding chunks and inline references. | Good search/index adapter, but we still need a page reader/browser for arbitrary URLs. Source: [Brave API docs](https://api-dashboard.search.brave.com/documentation), [official MCP server](https://github.com/brave/brave-search-mcp-server). |
| **Tavily** | Search with basic/advanced/fast/ultra-fast depth, domains, dates, country, topic, images, raw content, scores. | Extract accepts URL arrays, Markdown/text, advanced extraction, query-guided chunk reranking, and per-URL failures. Map discovers URLs; Crawl traverses a bounded site; Research produces a cited synthesis. | Search → Extract guidance, `chunks_per_source`, request IDs/result IDs, feedback, keyless Search/Extract. | Hosted service and credit budget. Keyless access does not cover all operations. Sources: [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract), [agent guidance](https://docs.tavily.com/agents). |
| **Exa** | Semantic search, categories, domains/paths, dates, multiple speed/depth modes, structured output. | Highlights, clean full text, summaries, max characters, freshness/livecrawl controls, subpages, per-URL statuses. | Highlights are query-focused and token-efficient; `maxAgeHours` expresses cache/freshness policy; batch fetch; deep search and agent runs. | Provider scores/IDs can be lost by wrappers; preserve raw result metadata. Sources: [Search](https://exa.ai/docs/reference/search-api-guide), [Contents](https://docs.exa.ai/reference/contents-retrieval). |
| **Firecrawl** | Search with operators, domains, categories, news/images, and optional scrape content in the same call. | Scrape Markdown/HTML, links, screenshots, JSON schema, targeted answers; Map URL inventories; Crawl bounded multi-page; Agent/Interact for broader browser research. | Clear separation of Search, Scrape, Map, Crawl, Agent, and Interaction. Search feedback and job IDs. | Powerful but hosted/operationally heavier. API success does not mean every target page succeeded; inspect page status/errors. Core repository license is AGPL. Sources: [Search](https://docs.firecrawl.dev/api-reference/v1-endpoint/search), [Scrape](https://docs.firecrawl.dev/features/scrape), [Crawl](https://docs.firecrawl.dev/features/crawl). |
| **Jina Reader/Search** | `s.jina.ai` search; MCP search/deep-search with reranking. | `r.jina.ai` Markdown extraction, dynamic pages, PDFs, OCR, CSS target/remove selectors, wait-for selector, token budget, cache controls, page timing, robots, Shadow DOM, iframe, custom JS. | Very small HTTP surface with many output controls; question-grounded extraction and listwise reranking. | Moves fetch/render decisions to a hosted service; rate limits/privacy need explicit policy. Sources: [Reader](https://jina.ai/en-US/reader/), [Reader source](https://github.com/jina-ai/reader), [Jina MCP](https://github.com/jina-ai/MCP). |
| **SearXNG** | Self-hosted metasearch; JSON/CSV/RSS, paging, categories, language, time range, safe search. | None; pair with local/hosted fetch. | Privacy/control, configurable upstream engines, no per-query vendor API required. | Operator owns instance health, upstream configuration, abuse controls, and API availability. Source: [Search API](https://docs.searxng.org/dev/search_api.html). |
| **Perplexity Sonar** | Model-integrated current search. | Returns a synthesized answer with citations and search results. | Search-context-size and model variants; good for answer-first workflows. | Less control over raw candidate ranking/extraction; model answer can blur retrieval and synthesis. Source: [Sonar API](https://docs.perplexity.ai/docs/sonar/quickstart). |
| **OpenAI/Anthropic/Gemini hosted search** | Search and, in some cases, search planning/reasoning. | Provider fetch/open/url-context paths. | Strong citations, domain controls, context/token controls, dynamic filtering, cached/live modes. | Provider-specific semantics, model cost, and less control over raw evidence; best treated as optional adapters. |
| **MCP reference Fetch** | None. | One bounded `fetch(url, max_length, start_index, raw)` tool with HTML→Markdown and pagination. | Minimal contract, offset paging, raw escape hatch. | Reference server warns about local/internal access and is not a complete production security policy. Source: [MCP Fetch server](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch). |

## 4. Building blocks of a robust pipeline

### 4.1 Query planning

A single search query is fine for a lookup; research needs a plan. Useful plan fields are:

```ts
type SearchPlan = {
  question: string;
  subquestions: string[];
  sourcePolicy: {
    allowedDomains?: string[];
    blockedDomains?: string[];
    freshness: "cache-ok" | "fresh-required";
  };
  budget: {
    maxQueries: number;
    maxResultsPerQuery: number;
    maxFetches: number;
    maxToolCalls: number;
    maxEvidenceTokens: number;
    maxWallClockMs: number;
  };
};
```

OpenAI's deep-research path, Anthropic's `max_uses`, Tavily's Search → Extract guidance, and LangChain's Open Deep Research all show the same pattern: broad discovery first, narrow gap-filling later, with explicit stop conditions and limits. The executor should enforce budgets; prompts alone are not enough.

### 4.2 Search and provider routing

A search adapter should normalize provider-specific results without discarding raw provenance:

```ts
type SearchResult = {
  sourceId: string;
  provider: string;
  rank: number;
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  author?: string;
  score?: number;
  providerRequestId?: string;
  providerResultId?: string;
  raw?: unknown;
};
```

Routing choices seen in the ecosystem:

- **Sequential fallback:** try configured providers until one succeeds.
- **Targeted combine:** query enough providers to get a few usable backends.
- **All-provider combine:** query all enabled providers in parallel and fuse results.
- **Active-model routing:** use a provider-native search tool when the current model supports it.
- **Provider health scoring:** choose by recent success, latency, quality, and quota.

`pi-search-hub` demonstrates all-provider/targeted combine and RRF. A useful default is sequential fallback, with explicit opt-in for fan-out because fan-out multiplies cost and privacy exposure.

### 4.3 Canonicalization and deduplication

Keep all URL identities rather than silently replacing them:

```ts
type UrlIdentity = {
  inputUrl: string;
  effectiveUrl?: string;
  declaredCanonicalUrl?: string;
  normalizedKey: string;
};
```

At minimum:

- remove fragments for retrieval identity;
- normalize host casing and trailing slash conservatively;
- preserve query parameters unless a provider-specific rule says they are tracking-only;
- record redirect destinations and canonical link declarations;
- dedupe exact normalized URLs;
- dedupe exact normalized content hashes;
- optionally cluster near duplicates with shingles/SimHash/embeddings;
- keep aliases and source records even when only one copy is sent to the model.

### 4.4 Static fetching

The direct HTTP path should own:

- timeout and abort propagation;
- response-size and content-type limits;
- redirect limits and policy revalidation on every hop;
- retries for transient network/5xx failures;
- `Retry-After` handling for 429/503;
- no automatic retries for unsafe/non-idempotent work;
- per-origin queue, concurrency, and rate limit;
- robots policy if configured;
- user-agent/header policy;
- response cache and HTTP revalidation;
- partial-success reporting.

RFC references: [RFC 9309 robots](https://www.rfc-editor.org/rfc/rfc9309.html), [RFC 6585 429](https://www.rfc-editor.org/rfc/rfc6585.html#section-4), [RFC 9110 retry semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2), [RFC 9111 caching](https://www.rfc-editor.org/rfc/rfc9111.html).

### 4.5 Rendering escalation

Static fetch and browser fetch should be separate stages:

```text
static HTML → extract → quality gate
                   ├─ good: return
                   └─ poor/JS-dependent: reader service or Playwright
```

A quality gate can look at:

- empty/very short body;
- title-only or cookie/consent text;
- high script-to-text ratio;
- known SPA shell markers;
- expected selector absent;
- extraction confidence below threshold;
- page declares a client-side app with no meaningful content.

Browser capabilities should be separate from read-only fetch. Browser actions (click/fill/submit) can cause side effects and need stronger permission/approval than fetching. Browser network traffic also needs SSRF checks at the route/interception layer, not only on the initial URL.

### 4.6 Extraction and formatting

No extractor wins on every page:

- Mozilla Readability is strong for article/main-content pages.
- Turndown is a formatter, not an extractor.
- Jina/Firecrawl/Exa/Tavily outsource rendering/extraction and often handle JS/PDFs better.
- Trafilatura, Scrapling, and Crawl4AI offer stronger structured/crawl-oriented alternatives but add runtime/deployment cost.
- Browser rendering supplies a DOM; it does not decide what is content.

Preserve a raw or HTML artifact for audit/debugging even when the model receives Markdown. Preserve heading paths, links, tables, code blocks, and exact text offsets rather than flattening everything into one string.

### 4.7 Reranking and reordering

Provider scores are not comparable. Reordering should use transparent stages:

1. provider rank/score as input metadata;
2. URL/content dedupe;
3. source-quality policy (official docs, primary source, repository, etc.);
4. query relevance or query-focused highlights;
5. freshness when the question needs it;
6. host/source diversity caps;
7. optional second-stage model/embedding rerank;
8. optional MMR to avoid ten near-identical sources.

For multi-provider results, Reciprocal Rank Fusion is robust because it combines rank positions without pretending vendor scores share a scale:

```text
RRF(d) = Σ 1 / (k + rank_r(d))
```

`pi-search-hub` uses `k=60`, normalized URL dedupe, and richest-content preference.

### 4.8 Token and context optimization

The main techniques are:

- return search cards/snippets first;
- fetch only selected URLs;
- use query-focused highlights/chunks before full text;
- store full content outside the transcript and page it by offset;
- support `findText`/question-grounded extraction for long pages;
- cap results per query, sources per domain, fetches, page bytes, page tokens, total evidence tokens, tool calls, wall clock, and money;
- chunk structurally by heading/paragraph/list/table/code before token fallback;
- preserve chunk IDs and offsets through summarization/compression;
- allow raw mode for technical/audit cases;
- dynamically filter results before context insertion;
- spill content to a file when it exceeds inline limits.

Examples:

- Anthropic dynamic filtering can run code before search/fetch content enters context.
- OpenAI exposes `search_context_size` and a reasoning-only returned token budget.
- Exa recommends highlights for factual lookups and limits full text with `maxCharacters`.
- Jina exposes `X-Token-Budget`, page selection, target selectors, and question extraction.
- The MCP reference Fetch server uses `max_length` plus `start_index` pagination.
- `pi-web-extension`, `pi-read-page`, `pi-web-access`, and Aider all use files/offsets or bounded output instead of dumping every page into the prompt.

A useful evidence-budget calculation is:

```text
evidenceBudget = modelContext
                - systemAndTools
                - conversation
                - reservedOutput
                - safetyMargin
```

Then select chunks by utility per token, for example:

```text
utility(chunk) = (relevance + authority + novelty + freshness) / tokenCount
```

### 4.9 Caching

Caching should be layered:

| Layer | Key | Invalidation |
|---|---|---|
| Search-result cache | provider + normalized query + filters + recency + result count | TTL, explicit fresh bypass |
| Raw HTTP cache | canonical URL + `Vary`-relevant headers | HTTP freshness, ETag/Last-Modified, `no-store` |
| Extraction cache | source snapshot hash + extractor/version/options | extractor/version/options change |
| Chunk/filter cache | normalized content hash + chunker/filter/options | transform configuration change |
| Rerank/summary cache | content/chunk IDs + query + model/prompt version | query/model/prompt/source snapshot change |
| Semantic cache | scoped query embedding + freshness/source policy | strict TTL and source snapshot checks |

`pi-search-hub` uses an in-memory LRU/TTL search cache. `pi-web-access` stores full content with bounded count/size and offset retrieval. Exa and Firecrawl expose freshness controls. LlamaIndex's ingestion cache keys transformations by document hash. Semantic caches are useful for stable intermediate work, but must not silently reuse a stale cited answer for a fresh-current question.

### 4.10 Provenance and citations

A provider's title/URL list is not enough for reliable research. Keep an evidence ledger:

```ts
type SourceDocument = {
  sourceId: string;
  inputUrl: string;
  effectiveUrl: string;
  canonicalUrl?: string;
  title?: string;
  fetchedAt: string;
  publishedAt?: string;
  discovery?: {
    provider: string;
    query: string;
    rank: number;
    providerRequestId?: string;
    providerResultId?: string;
  };
  retrieval?: {
    provider: string;
    httpStatus?: number;
    rendered: boolean;
    attempts: number;
  };
  extraction: {
    engine: string;
    version?: string;
    optionsHash: string;
  };
  contentHash: string;
};

type EvidenceChunk = {
  chunkId: string;
  sourceId: string;
  ordinal: number;
  headingPath: string[];
  text: string;
  start: number;
  end: number;
  tokenCount: number;
};

type Citation = {
  sourceId: string;
  chunkId: string;
  start: number;
  end: number;
  quote: string;
};
```

Validate citations before rendering:

1. cited source/chunk IDs were supplied to the writer;
2. offsets fit the stored chunk;
3. the quote exactly equals the stored substring;
4. the source remains allowed for the user/policy;
5. unsupported claims are qualified or marked unsupported;
6. consulted sources and actually cited sources remain distinguishable.

`pi-web-access`'s `source_check` is the closest Pi reference: exact passage IDs/offsets, hashes, source quality hints, and a deliberately conservative `unclear` status rather than pretending lexical matches prove a claim.

### 4.11 Security and privacy

Web content is hostile input, both for network security and prompt injection.

**Network policy:**

- allow only HTTP(S) by default;
- reject URL credentials;
- block localhost, loopback, RFC1918, link-local, metadata, reserved ranges, dangerous ports;
- resolve and re-check every redirect destination;
- apply the same policy to browser subrequests, iframes, XHR, and WebSockets;
- cap response bytes, decompression, redirects, and time;
- keep hosted fetch providers opt-in because the provider performs independent DNS/egress;
- never send authenticated cookies or private content to a hosted reader unless explicitly authorized.

**Prompt-injection policy:**

- wrap retrieved text in a clear untrusted-content boundary;
- neutralize the boundary-closing syntax;
- tell the model that page instructions are data, not instructions;
- sanitize or mark suspicious injection text rather than silently treating it as trusted;
- keep page links from expanding the research scope without an executor decision;
- maintain a distinction between a citation and a tool/action request.

`pi-browser-search` implements Unicode normalization, invisible/control-character removal, URL/base64 decoding, pattern redaction, random delimiters, and browser-network SSRF. This is a useful security reference, though sanitization should not replace provenance and policy.

## 5. Clever features worth borrowing

1. **Provider-native context controls:** OpenAI `search_context_size`/returned token budget, Anthropic dynamic filtering and response exclusion, Exa highlights, Jina token budget, Brave LLM Context.
2. **Search → extract as an explicit workflow:** Tavily recommends it; Firecrawl and Exa make it a first-class API shape.
3. **Search plus same-call content:** Firecrawl can attach scrape options to search results, useful when the result set is small and the model needs immediate evidence.
4. **Reader fallback chains:** `pi-search-hub` tries Jina/Sofya/Firecrawl/Exa, but treats credentials errors as fatal instead of pointlessly falling through.
5. **Targeted provider combine:** query only enough backends to obtain a few usable sources rather than always calling every backend.
6. **RRF across incompatible indexes:** combines rankings without comparing provider score scales.
7. **Quality-gated browser escalation:** static fetch first, render only when content is empty/JS-dependent/blocked.
8. **Persistent content outside the transcript:** `pi-web-extension`, `pi-read-page`, and `pi-web-access` return a file/response ID and let the agent page or search within stored content.
9. **Question-grounded extraction:** Tavily query/chunks, Jina question passages, Exa highlights, and `findText` all avoid sending irrelevant page bodies.
10. **Exact evidence artifacts:** source IDs, passage IDs, offsets, hashes, and conservative claim status make citations auditable.
11. **Specialized GitHub handling:** `pi-web-access` clones repositories rather than scraping rendered GitHub HTML; this is much better for code research.
12. **Specialized docs handling:** Context7 resolves a library and retrieves focused current docs rather than searching the general web.
13. **Feedback loops:** Tavily and Firecrawl preserve request/search IDs for source feedback and quality improvement.
14. **Freshness as a first-class parameter:** Exa `maxAgeHours`, Jina cache bypass/tolerance, Firecrawl `maxAge`, and Anthropic fetch cache bypass make “current” explicit instead of accidental.
15. **Operational diagnostics:** backend stats, fallback attempts, response IDs, cache status, extraction quality, and per-source failure records let the agent explain partial results.

## 6. Comparison with the current `my-pi` Brave skill

Current local files:

- `skills/brave-search/search.js`
- `skills/brave-search/content.js`
- `skills/brave-search/SKILL.md`

Current behavior:

- Brave Search API web search;
- query/count/country/freshness options;
- title/link/snippet/age output;
- optional sequential content fetching;
- native Node `fetch`;
- JSDOM + Mozilla Readability + Turndown/GFM;
- roughly 5,000-character content cap in the search path;
- separate known-URL content command;
- no provider-neutral result type;
- no source IDs/request IDs/content hashes;
- no retries or `Retry-After` handling;
- no content-type/response-size policy;
- no SSRF/redirect/DNS policy;
- no robots/rate-limit policy;
- no search/content cache;
- no batch fetch or bounded concurrency;
- no citation ledger or page offsets;
- shell-script invocation rather than an LLM-callable typed tool.

This is a good transparent baseline and keeps dependencies small. Its largest weaknesses are not the choice of Readability; they are missing orchestration, bounded retrieval, provenance, and operational policy.

## 7. Proposed shape of a “perfect” `my-pi` tool

### 7.1 Public surface

Start with three capabilities, not a sprawling provider catalog:

```text
web_search(query, options)
web_fetch(urls, options)
web_research(question, options)   // later, once the first two are solid
```

Keep browser interaction separate:

```text
web_browser(url, action plan)      // explicit, permissioned, side-effect capable
```

Suggested `web_search` options:

```ts
{
  query: string;
  maxResults?: number;
  recency?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
  category?: "web" | "news" | "images" | "video";
  freshness?: "cache-ok" | "fresh-required";
}
```

Suggested `web_fetch` options:

```ts
{
  urls: string | string[];
  format?: "markdown" | "text" | "html";
  maxCharacters?: number;
  maxTokens?: number;
  offset?: number;
  limit?: number;
  findText?: string | string[];
  question?: string;
  fresh?: boolean;
  render?: "never" | "on-failure" | "always";
}
```

### 7.2 Internal pipeline

```text
web_search
  → normalize provider response
  → canonicalize/dedupe URLs
  → apply source/domain policy
  → return compact source cards + responseId

web_fetch
  → validate URL and redirect policy
  → cache lookup/revalidation
  → robots/rate-limit queue
  → static HTTP fetch
  → JSDOM/Readability/Turndown
  → extraction quality gate
  → optional reader-provider fallback
  → optional Playwright/browser fallback
  → normalize, hash, chunk, store
  → return bounded preview/page/find-text result + source metadata

web_research (later)
  → build plan/subquestions/budget
  → search each subquestion
  → dedupe/rerank/diversify
  → fetch selected evidence
  → pack chunks to evidence budget
  → produce findings with validated citations
```

### 7.3 Provider strategy

Initial implementation should keep Brave as the search provider and direct Node fetching as the default reader. Add adapter seams, not dependencies, for:

- Jina Reader as the first hosted extraction fallback;
- Exa or Tavily when a user configures a key and wants query-aware highlights/extraction;
- Firecrawl when crawl/render/interact jobs justify it;
- SearXNG when self-hosted/private discovery matters;
- Context7 as a separate docs-specific tool.

Do not start by requiring Python, Docker, SearXNG, Playwright, or a hosted provider. All of those should be optional.

### 7.4 Storage and context behavior

- Store full extracted documents outside the transcript under a session-scoped cache.
- Return a compact preview, title, source ID, content length, and `nextOffset`.
- Let the agent page by offset or ask for matching passages.
- Keep raw HTML optionally available for audit/debugging.
- Cache raw fetches and extraction separately.
- Include extractor/version/options in extraction cache keys.
- Preserve failed attempts and fallback path in details.

## 8. Suggested implementation sequence

### Phase 1 — make the current path a real core

- Extract a shared TypeScript fetch/extract module used by both commands.
- Define canonical search/fetch/document/result types.
- Add URL normalization and redirect/SSRF policy.
- Add content type, byte, timeout, retry, and `Retry-After` handling.
- Add bounded parallel fetch for `--content`.
- Preserve source IDs and effective URLs.

### Phase 2 — context and evidence

- Add file-backed/session-backed document cache.
- Add offset/limit and `findText` retrieval.
- Add structural Markdown chunking with heading paths and exact offsets.
- Return compact previews and a response ID rather than full documents by default.
- Add content hashes and extraction metadata.

### Phase 3 — quality and fallback

- Add extraction quality scoring.
- Add configurable Jina/Exa/Tavily/Firecrawl adapters behind a common reader interface.
- Escalate static → hosted reader → browser only when needed.
- Add per-source status and partial success.

### Phase 4 — ranking and research

- Add multi-query search plans.
- Add URL/content dedupe and source diversity caps.
- Add optional RRF/MMR/reranking.
- Add evidence-budget packing.
- Add `web_research` only after search/fetch/evidence primitives are reliable.

### Phase 5 — evaluation

Create a fixed benchmark with:

- server-rendered articles and docs;
- client-rendered SPA pages;
- delayed XHR and lazy-loaded pages;
- tables/code/PDFs;
- cookie walls and blocked pages;
- long navigation-heavy docs;
- duplicate/syndicated sources;
- redirects and non-HTML content;
- private/unsafe URL tests;
- transient 429/5xx fixtures.

Measure:

- extraction usefulness and completeness;
- title/heading/link/table preservation;
- token and byte volume delivered to the model;
- latency and provider cost;
- fallback success rate;
- cache hit rate;
- citation exactness;
- SSRF/prompt-injection policy behavior;
- partial-failure clarity.

## 9. Decisions still open

1. Should `my-pi` remain Brave-only initially, or support a second search backend immediately?
2. Is hosted page extraction acceptable for this package, or should direct HTTP be the default everywhere?
3. Should the default output be a temp file, an inline bounded preview, or both?
4. What is the default evidence/content budget for a normal coding question?
5. How strict should robots enforcement be, and should it be opt-in or default?
6. Is a local Playwright dependency acceptable as an optional install, or should browser rendering be external-only?
7. Should citations be required for every fetched-source claim, or only for an explicit `web_research` mode?
8. Do we want interactive browser actions at all, or only read-only rendered fetch?
9. Should multi-provider combine be a user-visible option or an internal fallback policy?
10. Which cache data is safe to persist across sessions, and what freshness guarantees should each mode provide?

## Primary sources

- Pi [skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- OpenAI [Web Search](https://developers.openai.com/api/docs/guides/tools-web-search) and [Codex web search](https://developers.openai.com/codex/web-search)
- Anthropic [Web Search](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool) and [Web Fetch](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-fetch-tool)
- Gemini CLI [web search](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/web-search.md) and [web fetch](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/web-fetch.md)
- Cursor [Agent](https://cursor.com/docs/agent/overview) and [browser](https://cursor.com/docs/agent/tools/browser)
- Cline [tools](https://docs.cline.bot/tools-reference/all-cline-tools)
- Continue [search tool](https://github.com/continuedev/continue/blob/main/core/tools/definitions/searchWeb.ts) and [fetch tool](https://github.com/continuedev/continue/blob/main/core/tools/definitions/fetchUrlContent.ts)
- OpenCode [tools](https://opencode.ai/docs/tools/)
- Aider [URL context](https://aider.chat/docs/usage/images-urls.html)
- Goose [web-search skill](https://github.com/block/goose/blob/main/crates/goose/src/skills/builtins/web_search.md)
- Brave [Search API](https://api-dashboard.search.brave.com/documentation) and [MCP server](https://github.com/brave/brave-search-mcp-server)
- Tavily [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract), and [agents guidance](https://docs.tavily.com/agents)
- Exa [Search](https://exa.ai/docs/reference/search-api-guide) and [Contents](https://docs.exa.ai/reference/contents-retrieval)
- Firecrawl [Search](https://docs.firecrawl.dev/api-reference/v1-endpoint/search), [Scrape](https://docs.firecrawl.dev/features/scrape), and [Crawl](https://docs.firecrawl.dev/features/crawl)
- Jina [Reader](https://jina.ai/en-US/reader/) and [MCP](https://github.com/jina-ai/MCP)
- SearXNG [Search API](https://docs.searxng.org/dev/search_api.html)
- MCP reference [Fetch server](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch)
- Pi packages: [`pi-search-hub`](https://github.com/ronnieops/pi-search-hub), [`pi-web-access`](https://github.com/nicobailon/pi-web-access), [`pi-web-toolkit`](https://github.com/Wade11s/pi-web-toolkit), [`pi-read-page`](https://github.com/Sukitly/pi-read-page), [`pi-browser-search`](https://github.com/sebaxzero/pi-browser-search), [`pi-web-extension`](https://github.com/NicoAvanzDev/pi-web-extension), [`pi-web-search-and-fetch`](https://github.com/xinaps-dev/pi-web-search-and-fetch), [`Context7 Pi`](https://github.com/upstash/context7/tree/master/packages/pi)
- Standards: [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html), [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html), [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html), [W3C PROV-DM](https://www.w3.org/TR/prov-dm/)
