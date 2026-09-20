import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TtlLruCache } from "./cache.js";
import { openFetchStore } from "./fetch-store.js";
import type { SearchResponse } from "./types.js";
import { runWebSearch, webSearchParameters, type WebSearchParams } from "./web-search.js";
import { runWebFetch, webFetchParameters, type WebFetchParams } from "./web-fetch.js";

/**
 * web-tools extension: `web_search` and `web_fetch`.
 * Architecture and contract: docs/plans/web-tools.md.
 */
export default function (pi: ExtensionAPI) {
	// Search responses are volatile → memory-only, short TTL.
	const searchCache = new TtlLruCache<{ response: SearchResponse; dropped: number }>(
		5 * 60 * 1000,
		100,
	);
	// Fetched pages are durable → disk store under the pi agent dir.
	const fetchStore = openFetchStore();

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Brave and return compact result cards (title, URL, snippet, age). Use web_fetch to read the content of a result.",
		parameters: webSearchParameters,
		promptGuidelines: [
			"Use web_search to discover sources; it returns links and snippets, not page content.",
			"Fetch only the most promising results with web_fetch rather than everything.",
		],
		async execute(_toolCallId, params: WebSearchParams, signal) {
			const outcome = await runWebSearch(params, { cache: searchCache, signal });
			return {
				content: [{ type: "text" as const, text: outcome.text }],
				details: outcome.details,
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch one or more URLs (max 8) as markdown via Readability. Full content is stored on disk — explore with findText first to pull the passages relevant to your goal, then use offset to read around or past a hit.",
		parameters: webFetchParameters,
		promptGuidelines: [
			"Use web_fetch on URLs you already know (from web_search or the user).",
			"Explore a fetched page with findText first: pass terms from your goal and read only the matching passages. Read from the start only when findText returns nothing useful.",
			"Long output is truncated — continue with the reported offset instead of refetching.",
		],
		async execute(_toolCallId, params: WebFetchParams, signal) {
			const outcome = await runWebFetch(params, { store: fetchStore, signal });
			return {
				content: [{ type: "text" as const, text: outcome.text }],
				details: outcome.details,
			};
		},
	});
}
