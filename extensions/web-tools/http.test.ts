import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpFetch, HttpFetchError, parseRetryAfterMs, type HttpFetchOptions } from "./http.js";

/** Build test options: instant sleep (recorded), fixed clock, mocked fetch. */
function makeOpts(fetchImpl: typeof fetch): HttpFetchOptions & { sleeps: number[] } {
	const sleeps: number[] = [];
	return {
		fetchImpl,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		now: () => Date.parse("2026-09-18T12:00:00Z"),
		sleeps,
	};
}

function textResponse(body: string, init: ResponseInit = {}): Response {
	return new Response(body, init);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("httpFetch", () => {
	it("returns a successful response with effective URL and content type", async () => {
		fetchMock.mockResolvedValue(
			textResponse("<html>hi</html>", {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		);
		const res = await httpFetch("https://example.com/a", makeOpts(fetchMock));
		expect(res.status).toBe(200);
		expect(res.body).toBe("<html>hi</html>");
		expect(res.contentType).toContain("text/html");
		expect(res.effectiveUrl).toBe("https://example.com/a");
		expect(res.attempts).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("follows redirects manually and validates each hop", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: "https://other.com/b" } }),
			)
			.mockResolvedValueOnce(textResponse("ok", { status: 200 }));
		const res = await httpFetch("https://example.com/a", makeOpts(fetchMock));
		expect(res.effectiveUrl).toBe("https://other.com/b");
		expect(res.body).toBe("ok");
		// manual redirect mode
		expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
	});

	it("blocks a redirect that violates policy mid-chain", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, { status: 301, headers: { location: "http://127.0.0.1/x" } }),
		);
		await expect(httpFetch("https://example.com/a", makeOpts(fetchMock))).rejects.toMatchObject({
			code: "blocked-url",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("blocks a TLS-downgrade redirect", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location: "http://example.com/b" } }),
		);
		await expect(httpFetch("https://example.com/a", makeOpts(fetchMock))).rejects.toMatchObject({
			code: "blocked-url",
		});
	});

	it("fails after too many redirects", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			new Response(null, {
				status: 302,
				headers: { location: `${url}r` },
			}),
		);
		await expect(
			httpFetch("https://example.com/a", { ...makeOpts(fetchMock), maxRedirects: 3 }),
		).rejects.toMatchObject({ code: "http-error" });
	});

	it("retries 429 honoring delay-seconds Retry-After, capped at 30s", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response("rate limited", {
					status: 429,
					headers: { "retry-after": "120" },
				}),
			)
			.mockResolvedValueOnce(textResponse("ok", { status: 200 }));
		const opts = makeOpts(fetchMock);
		await httpFetch("https://example.com/a", opts);
		expect(opts.sleeps).toEqual([30_000]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries 503 honoring HTTP-date Retry-After", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response("busy", {
					status: 503,
					headers: { "retry-after": "Fri, 18 Sep 2026 12:00:10 GMT" },
				}),
			)
			.mockResolvedValueOnce(textResponse("ok", { status: 200 }));
		const opts = makeOpts(fetchMock);
		await httpFetch("https://example.com/a", opts);
		// Fixed clock is 12:00:00Z → 10s delay
		expect(opts.sleeps.length).toBe(1);
		expect(opts.sleeps[0]).toBeGreaterThanOrEqual(9_000);
		expect(opts.sleeps[0]).toBeLessThanOrEqual(10_000);
	});

	it("throws retry-exhausted when 5xx persists", async () => {
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
		const opts = makeOpts(fetchMock);
		await expect(httpFetch("https://example.com/a", opts)).rejects.toMatchObject({
			code: "retry-exhausted",
			status: 500,
			attempts: 3,
		});
		// exponential backoff sleeps between attempts
		expect(opts.sleeps.length).toBe(2);
	});

	it("fails immediately on 404 without retrying", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
		const opts = makeOpts(fetchMock);
		await expect(httpFetch("https://example.com/a", opts)).rejects.toMatchObject({
			code: "http-error",
			status: 404,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(opts.sleeps).toEqual([]);
	});

	it("retries network errors then succeeds", async () => {
		fetchMock
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(textResponse("ok", { status: 200 }));
		await httpFetch("https://example.com/a", makeOpts(fetchMock));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("throws network when connection failures persist", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		await expect(httpFetch("https://example.com/a", makeOpts(fetchMock))).rejects.toMatchObject({
			code: "network",
			attempts: 3,
		});
	});

	it("throws timeout when requests exceed the deadline", async () => {
		const opts = {
			...makeOpts(fetchMock),
			timeoutMs: 5,
			sleep: async () => {
				// no-op
			},
		};
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		await expect(httpFetch("https://example.com/a", opts)).rejects.toMatchObject({
			code: "timeout",
		});
	});

	it("rejects oversize content-length before reading the body", async () => {
		fetchMock.mockResolvedValue(
			new Response(null, {
				status: 200,
				headers: { "content-length": "99999999" },
			}),
		);
		await expect(
			httpFetch("https://example.com/a", { ...makeOpts(fetchMock), maxBytes: 100 }),
		).rejects.toMatchObject({ code: "too-large" });
	});

	it("rejects oversize streamed bodies", async () => {
		const big = "x".repeat(1000);
		fetchMock.mockResolvedValue(textResponse(big, { status: 200 }));
		await expect(
			httpFetch("https://example.com/a", { ...makeOpts(fetchMock), maxBytes: 100 }),
		).rejects.toMatchObject({ code: "too-large" });
	});

	it("blocks policy-violating URLs without any fetch", async () => {
		await expect(
			httpFetch("http://127.0.0.1:8080/x", makeOpts(fetchMock)),
		).rejects.toMatchObject({ code: "blocked-url" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("propagates caller cancellation without retrying", async () => {
		const caller = new AbortController();
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
					caller.abort();
				}),
		);
		const opts = { ...makeOpts(fetchMock), signal: caller.signal };
		await expect(httpFetch("https://example.com/a", opts)).rejects.toBeInstanceOf(Error);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("parseRetryAfterMs", () => {
	const now = () => Date.parse("2026-09-18T12:00:00Z");

	it("parses delay-seconds", () => {
		expect(parseRetryAfterMs("30", now)).toBe(30_000);
		expect(parseRetryAfterMs("0", now)).toBe(0);
	});

	it("parses HTTP-dates relative to now", () => {
		expect(parseRetryAfterMs("Fri, 18 Sep 2026 12:00:05 GMT", now)).toBe(5_000);
		// dates in the past clamp to zero
		expect(parseRetryAfterMs("Fri, 18 Sep 2026 11:00:00 GMT", now)).toBe(0);
	});

	it("returns null for missing or unparseable values", () => {
		expect(parseRetryAfterMs(null, now)).toBeNull();
		expect(parseRetryAfterMs("soon", now)).toBeNull();
	});
});

describe("HttpFetchError", () => {
	it("carries code, status, and attempts", () => {
		const err = new HttpFetchError("http-error", "HTTP 404", 404, 2);
		expect(err.code).toBe("http-error");
		expect(err.status).toBe(404);
		expect(err.attempts).toBe(2);
		expect(err).toBeInstanceOf(Error);
	});
});
