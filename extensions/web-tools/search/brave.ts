/**
 * Brave Search API adapter.
 * Contract: docs/plans/web-tools.md → Interfaces → Brave adapter.
 */

import type { SearchResponse, SearchResult } from "../types.js";
import { newResponseId } from "../response-id.js";

export interface BraveSearchParams {
	query: string;
	/** Default 5, max 20. */
	count?: number;
	/** Brave freshness string, validated passthrough (pd/pw/pm/py or date range). */
	freshness?: string;
	signal?: AbortSignal;
	/** Injection point for tests. */
	fetchImpl?: typeof fetch;
}

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const FRESHNESS_PATTERN =
	/^(pd|pw|pm|py|py-[0-9]{4}|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/i;

export async function braveSearch(params: BraveSearchParams): Promise<SearchResponse> {
	const apiKey = process.env.BRAVE_API_KEY;
	if (!apiKey) {
		throw new Error(
			"BRAVE_API_KEY is not set. Get a key at https://api-dashboard.search.brave.com/app/keys",
		);
	}

	const count = Math.max(1, Math.min(20, params.count ?? 5));
	const searchParams = new URLSearchParams({ q: params.query, count: String(count) });

	if (params.freshness !== undefined) {
		if (!FRESHNESS_PATTERN.test(params.freshness)) {
			throw new Error(
				`invalid freshness "${params.freshness}" — use pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD`,
			);
		}
		searchParams.set("freshness", params.freshness);
	}

	const doFetch = params.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(`${ENDPOINT}?${searchParams.toString()}`, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": apiKey,
			},
			signal: params.signal,
		});
	} catch (err) {
		throw new Error(`Brave search request failed: ${err instanceof Error ? err.message : err}`);
	}

	if (!response.ok) {
		// Never include the API key or the raw body in errors.
		throw new Error(`Brave search failed: HTTP ${response.status}`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error("Brave search returned a non-JSON response");
	}

	const raw = (data as { web?: { results?: unknown[] } })?.web?.results ?? [];
	const results: SearchResult[] = [];
	for (const item of raw) {
		if (results.length >= count) break;
		const r = item as Record<string, unknown>;
		const url = typeof r.url === "string" ? r.url : "";
		const title = typeof r.title === "string" ? r.title.trim() : "";
		if (!url || !title) continue;
		results.push({
			sourceId: `s${results.length + 1}`,
			url,
			title,
			snippet: typeof r.description === "string" ? r.description : undefined,
			age: typeof (r.age ?? r.page_age) === "string" ? String(r.age ?? r.page_age) : undefined,
			provider: "brave",
			rank: raw.indexOf(item) + 1,
		});
	}

	return { query: params.query, results, responseId: newResponseId() };
}
