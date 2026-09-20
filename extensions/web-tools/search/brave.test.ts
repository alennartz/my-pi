import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { braveSearch } from "./brave.js";

const FIXTURE = {
	web: {
		results: [
			{
				url: "https://example.com/one",
				title: "First Result",
				description: "About the first thing.",
				age: "2 days ago",
			},
			{ url: "https://example.com/two", title: "Second Result" },
			{ url: "", title: "Dropped: no URL" },
			{ url: "https://example.com/no-title", title: "  " },
		],
	},
};

function okBody(extra: object = {}) {
	return new Response(JSON.stringify({ ...FIXTURE, ...extra }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	process.env.BRAVE_API_KEY = "test-key-123";
});

afterEach(() => {
	delete process.env.BRAVE_API_KEY;
	vi.restoreAllMocks();
});

describe("braveSearch", () => {
	it("maps results and assigns source ids and ranks", async () => {
		fetchMock.mockResolvedValue(okBody());
		const response = await braveSearch({ query: "q", fetchImpl: fetchMock });
		expect(response.query).toBe("q");
		expect(response.responseId).toMatch(/^[0-9a-f]{12}$/);
		expect(response.results).toEqual([
			{
				sourceId: "s1",
				url: "https://example.com/one",
				title: "First Result",
				snippet: "About the first thing.",
				age: "2 days ago",
				provider: "brave",
				rank: 1,
			},
			{
				sourceId: "s2",
				url: "https://example.com/two",
				title: "Second Result",
				snippet: undefined,
				age: undefined,
				provider: "brave",
				rank: 2,
			},
		]);
	});

	it("sends the subscription token header and query params", async () => {
		fetchMock.mockResolvedValue(okBody());
		await braveSearch({ query: "hello world", count: 10, fetchImpl: fetchMock });
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("q=hello+world");
		expect(String(url)).toContain("count=10");
		expect(init.headers["X-Subscription-Token"]).toBe("test-key-123");
	});

	it("clamps count to 1..20", async () => {
		fetchMock.mockResolvedValue(okBody());
		await braveSearch({ query: "q", count: 99, fetchImpl: fetchMock });
		expect(fetchMock.mock.calls[0][0]).toContain("count=20");
	});

	it("passes validated freshness through", async () => {
		fetchMock.mockResolvedValue(okBody());
		await braveSearch({ query: "q", freshness: "pw", fetchImpl: fetchMock });
		expect(fetchMock.mock.calls[0][0]).toContain("freshness=pw");
	});

	it("rejects malformed freshness", async () => {
		await expect(
			braveSearch({ query: "q", freshness: "last-week", fetchImpl: fetchMock }),
		).rejects.toThrow(/invalid freshness/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("errors with a clear message when the key is missing", async () => {
		delete process.env.BRAVE_API_KEY;
		await expect(braveSearch({ query: "q", fetchImpl: fetchMock })).rejects.toThrow(
			/BRAVE_API_KEY/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports HTTP failures without leaking the key", async () => {
		fetchMock.mockResolvedValue(
			new Response('{"message":"invalid key: test-key-123"}', { status: 401 }),
		);
		await expect(braveSearch({ query: "q", fetchImpl: fetchMock })).rejects.toThrow(
			/HTTP 401/,
		);
		await expect(braveSearch({ query: "q", fetchImpl: fetchMock })).rejects.not.toThrow(
			/test-key-123/,
		);
	});

	it("handles empty result sets", async () => {
		fetchMock.mockResolvedValue(okBody({ web: { results: [] } }));
		const response = await braveSearch({ query: "q", fetchImpl: fetchMock });
		expect(response.results).toEqual([]);
	});
});
