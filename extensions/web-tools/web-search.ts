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

/** JSON schema of structuredContent: the full response plus the filter drop count. */
export const webSearchOutput = Type.Object({
	query: Type.String({ description: "The search query" }),
	results: Type.Array(
		Type.Object({
			sourceId: Type.String({ description: 'Stable within a response: "s1", "s2", ...' }),
			url: Type.String({ description: "Result URL as returned by the provider" }),
			title: Type.String(),
			snippet: Type.Optional(Type.String()),
			age: Type.Optional(
				Type.String({ description: 'Provider age string, verbatim (e.g. "2 days ago")' }),
			),
			provider: Type.Literal("brave"),
			rank: Type.Number({ description: "1-based position before dedupe" }),
		}),
	),
	responseId: Type.String({
		description: "Random id; key for follow-up retrieval of this response",
	}),
	dropped: Type.Number({ description: "Results hidden by domain filters" }),
});

export type WebSearchStructured = Static<typeof webSearchOutput>;

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
	/** Same object as `details`. */
	structuredContent: WebSearchStructured;
}

/** Core search pipeline — cache → adapter → dedupe → filters → cards. */
export async function runWebSearch(
	params: WebSearchParams,
	deps: WebSearchDeps,
): Promise<WebSearchOutcome> {
	const key = cacheKeyFor(params);
	const cached = deps.cache.get(key);
	if (cached) {
		const details = { ...cached.response, dropped: cached.dropped };
		return {
			text: renderCached(cached.response, cached.dropped),
			details,
			structuredContent: details,
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
	const details = { ...filtered, dropped };

	deps.cache.set(key, { response: filtered, dropped });
	return {
		text: renderCached(filtered, dropped),
		details,
		structuredContent: details,
	};
}

function renderCached(response: SearchResponse, dropped: number): string {
	const cards = renderSearchCards(response);
	if (dropped > 0) {
		return `${cards}\n\n(${dropped} result${dropped === 1 ? "" : "s"} hidden by domain filter)`;
	}
	return cards;
}
