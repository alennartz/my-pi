import { describe, expect, it } from "vitest";
import type { SearchResult } from "../types.js";
import {
	applyDomainFilters,
	canonicalUrlKey,
	dedupeResults,
	renderSearchCards,
} from "./normalize.js";

function result(url: string, rank: number, overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		sourceId: `s${rank}`,
		url,
		title: `Result ${rank}`,
		snippet: "A snippet.",
		provider: "brave",
		rank,
		...overrides,
	};
}

describe("canonicalUrlKey", () => {
	it("strips fragments and trailing slashes, lowercases host", () => {
		expect(canonicalUrlKey("https://Example.com/Page/#section")).toBe(
			"https://example.com/Page",
		);
		expect(canonicalUrlKey("https://example.com///")).toBe("https://example.com/");
	});

	it("keeps query parameters and path case", () => {
		expect(canonicalUrlKey("https://example.com/Docs?a=1&b=2#x")).toBe(
			"https://example.com/Docs?a=1&b=2",
		);
	});

	it("falls back to lowercased input for unparseable URLs", () => {
		expect(canonicalUrlKey("Not A URL")).toBe("not a url");
	});
});

describe("dedupeResults", () => {
	it("keeps the best-rank entry per canonical URL", () => {
		const out = dedupeResults([
			result("https://example.com/a", 1),
			result("https://example.com/a/", 2),
			result("https://example.com/a#top", 3),
			result("https://other.com/b", 4),
		]);
		expect(out.map((r) => r.rank)).toEqual([1, 4]);
	});

	it("does not merge different queries or hosts", () => {
		const out = dedupeResults([
			result("https://example.com/?a=1", 1),
			result("https://example.com/?a=2", 2),
			result("https://other.example.com/", 3),
		]);
		expect(out).toHaveLength(3);
	});
});

describe("renderSearchCards", () => {
	it("renders numbered cards with url, age, snippet", () => {
		const text = renderSearchCards({
			query: "q",
			responseId: "r1",
			results: [
				result("https://example.com/a", 1, { age: "2 days ago" }),
				result("https://other.com/b", 2, { snippet: undefined, age: undefined }),
			],
		});
		expect(text).toContain("1. Result 1");
		expect(text).toContain("https://example.com/a");
		expect(text).toContain("Age: 2 days ago");
		expect(text).toContain("A snippet.");
		expect(text).toContain("2. Result 2");
		// Card without age/snippet has neither line
		const secondCard = text.split("\n\n")[1];
		expect(secondCard).not.toContain("Age:");
		expect(secondCard).not.toContain("snippet");
	});

	it("renders a no-results message for empty responses", () => {
		const text = renderSearchCards({ query: "nothing", responseId: "r2", results: [] });
		expect(text).toBe("No results found for: nothing");
	});
});

describe("applyDomainFilters", () => {
	const results = [
		result("https://docs.python.org/3/", 1),
		result("https://www.python.org/", 2),
		result("https://stackoverflow.com/q/1", 3),
		result("https://news.ycombinator.com/item?id=1", 4),
	];

	it("include filter matches domain and subdomains", () => {
		const { kept, dropped } = applyDomainFilters(results, ["python.org"]);
		expect(kept.map((r) => r.rank)).toEqual([1, 2]);
		expect(dropped).toBe(2);
	});

	it("exclude filter removes matching domains", () => {
		const { kept } = applyDomainFilters(results, undefined, ["stackoverflow.com"]);
		expect(kept.map((r) => r.rank)).toEqual([1, 2, 4]);
	});

	it("normalizes scheme-prefixed domain entries", () => {
		const { kept } = applyDomainFilters(results, ["https://www.python.org"]);
		expect(kept.map((r) => r.rank)).toEqual([2]);
	});

	it("drops unparseable URLs", () => {
		const { kept } = applyDomainFilters([result("not a url", 1)], ["example.com"]);
		expect(kept).toHaveLength(0);
	});

	it("no filters keeps everything", () => {
		const { kept, dropped } = applyDomainFilters(results);
		expect(kept).toHaveLength(4);
		expect(dropped).toBe(0);
	});
});
