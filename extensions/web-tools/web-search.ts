/**
 * web_search tool — Brave discovery, dedupe, domain filters, compact cards.
 * Contract: docs/plans/web-tools.md → Interfaces → Tool registration.
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { TtlLruCache } from "./cache.js";
import { braveSearch } from "./search/brave.js";
import { applyDomainFilters, dedupeResults, renderSearchCards } from "./search/normalize.js";
import type { SearchResponse } from "./types.js";

export const webSearchParameters = Type.Object({
	query: Type.String({ minLength: 1, description: "The search query" }),
	maxResults: Type.Optional(
		Type.Number({ minimum: 1, maximum: 20, description: "Results to return (default 5, max 20)" }),
	),
	freshness: Type.Optional(
		Type.String({
			description:
				"Time filter: pd (day), pw (week), pm (month), py (year), or YYYY-MM-DDtoYYYY-MM-DD",
		}),
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Only include results from these domains" }),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Drop results from these domains" }),
	),
});

export type WebSearchParams = Static<typeof webSearchParameters>;

export interface WebSearchDeps {
	/** Search cache shared across calls in this process. */
	cache: TtlLruCache<{ response: SearchResponse; dropped: number }>;
	/** Adapter — injectable for tests. */
	search?: typeof braveSearch;
	signal?: AbortSignal;
}

function cacheKeyFor(params: WebSearchParams): string {
	const opts = JSON.stringify({
		maxResults: params.maxResults ?? 5,
		freshness: params.freshness ?? "",
		includeDomains: [...(params.includeDomains ?? [])].sort(),
		excludeDomains: [...(params.excludeDomains ?? [])].sort(),
	});
	return `${opts}\n${params.query.trim().toLowerCase()}`;
}

export interface WebSearchOutcome {
	text: string;
	details: SearchResponse & { dropped: number };
}

/** Core search pipeline — cache → adapter → dedupe → filters → cards. */
export async function runWebSearch(
	params: WebSearchParams,
	deps: WebSearchDeps,
): Promise<WebSearchOutcome> {
	const key = cacheKeyFor(params);
	const cached = deps.cache.get(key);
	if (cached) {
		return {
			text: renderCached(cached.response, cached.dropped),
			details: { ...cached.response, dropped: cached.dropped },
		};
	}

	const response = await (
		deps.search ??
		(async (p: Parameters<typeof braveSearch>[0]) => braveSearch(p))
	)({
		query: params.query,
		count: params.maxResults,
		freshness: params.freshness,
		signal: deps.signal,
	});

	const deduped = dedupeResults(response.results);
	const { kept, dropped } = applyDomainFilters(deduped, params.includeDomains, params.excludeDomains);
	const filtered: SearchResponse = { ...response, results: kept };

	deps.cache.set(key, { response: filtered, dropped });
	return {
		text: renderCached(filtered, dropped),
		details: { ...filtered, dropped },
	};
}

function renderCached(response: SearchResponse, dropped: number): string {
	const cards = renderSearchCards(response);
	if (dropped > 0) {
		return `${cards}\n\n(${dropped} result${dropped === 1 ? "" : "s"} hidden by domain filter)`;
	}
	return cards;
}
