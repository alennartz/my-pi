import { describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "./types.js";
import { runWebSearch, type WebSearchParams } from "./web-search.js";
import { TtlLruCache } from "./cache.js";

function fakeResponse(urls: string[], query = "test query"): SearchResponse {
	return {
		query,
		responseId: "abc123",
		results: urls.map((url, i) => ({
			sourceId: `s${i + 1}`,
			url,
			title: `Result ${i + 1}`,
			snippet: "snippet",
			provider: "brave" as const,
			rank: i + 1,
		})),
	};
}

function deps() {
	return { cache: new TtlLruCache<{ response: SearchResponse; dropped: number }>(60_000, 100) };
}

const baseParams: WebSearchParams = { query: "test query" };

describe("runWebSearch", () => {
	it("calls the adapter once and serves the second call from cache", async () => {
		const search = vi.fn(async () => fakeResponse(["https://a.com/1"]));
		const d = deps();
		const outcome1 = await runWebSearch(baseParams, { ...d, search });
		const outcome2 = await runWebSearch(baseParams, { ...d, search });
		expect(search).toHaveBeenCalledTimes(1);
		expect(outcome2.text).toBe(outcome1.text);
		expect(outcome1.text).toContain("1. Result 1");
		expect(outcome1.details.results).toHaveLength(1);
	});

	it("dedupes results before rendering", async () => {
		const search = vi.fn(async () =>
			fakeResponse(["https://a.com/1", "https://a.com/1/", "https://b.com/2"]),
		);
		const outcome = await runWebSearch(baseParams, { ...deps(), search });
		expect(outcome.details.results).toHaveLength(2);
		expect(outcome.text).toContain("https://b.com/2");
		expect(outcome.text).not.toContain("https://a.com/1/");
	});

	it("applies domain filters and notes hidden results", async () => {
		const search = vi.fn(async () =>
			fakeResponse(["https://docs.python.org/3", "https://stackoverflow.com/q"]),
		);
		const outcome = await runWebSearch(
			{ ...baseParams, includeDomains: ["python.org"] },
			{ ...deps(), search },
		);
		expect(outcome.details.results.map((r) => r.url)).toEqual(["https://docs.python.org/3"]);
		expect(outcome.text).toContain("1 result hidden by domain filter");
	});

	it("exclude filters drop matching domains", async () => {
		const search = vi.fn(async () =>
			fakeResponse(["https://docs.python.org/3", "https://stackoverflow.com/q"]),
		);
		const outcome = await runWebSearch(
			{ ...baseParams, excludeDomains: ["stackoverflow.com"] },
			{ ...deps(), search },
		);
		expect(outcome.details.results).toHaveLength(1);
		expect(outcome.text).toContain("1 result hidden by domain filter");
	});

	it("renders a no-results message", async () => {
		const search = vi.fn(async () => fakeResponse([]));
		const outcome = await runWebSearch(baseParams, { ...deps(), search });
		expect(outcome.text).toBe("No results found for: test query");
	});

	it("surfaces adapter errors", async () => {
		const search = vi.fn(async () => {
			throw new Error("BRAVE_API_KEY is not set.");
		});
		await expect(runWebSearch(baseParams, { ...deps(), search })).rejects.toThrow(
			/BRAVE_API_KEY/,
		);
	});

	it("caches per distinct options", async () => {
		const search = vi.fn(async () => fakeResponse(["https://a.com/1"]));
		await runWebSearch({ ...baseParams, maxResults: 5 }, { ...deps(), search });
		await runWebSearch({ ...baseParams, maxResults: 10 }, { ...deps(), search });
		expect(search).toHaveBeenCalledTimes(2);
	});
});
