import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFetchStore, type FetchStore } from "./fetch-store.js";
import { mapWithConcurrency, runWebFetch, type WebFetchParams } from "./web-fetch.js";

const articleHtml = readFileSync(
	join(import.meta.dirname, "fixtures", "article.html"),
	"utf-8",
);

function htmlResponse(html: string): Response {
	return new Response(html, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

let dir: string;
let store: FetchStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "web-tools-fetch-"));
	store = openFetchStore(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function deps(fetchImpl?: typeof fetch) {
	return { store, fetchImpl };
}

describe("runWebFetch", () => {
	it("fetches a URL and renders bounded markdown", async () => {
		const fetchImpl = vi.fn(async () => htmlResponse(articleHtml));
		const outcome = await runWebFetch({ url: "https://example.com/streams" }, deps(fetchImpl));
		expect(outcome.details).toHaveLength(1);
		const r = outcome.details[0];
		expect(r.status).toBe("ok");
		expect(r.title).toBe("Understanding Node Streams");
		expect(r.fromCache).toBe(false);
		expect(r.markdown).toContain("## Backpressure");
		expect(outcome.text).toContain("=== https://example.com/streams");
		expect(outcome.text).toContain("Title: Understanding Node Streams");
	});

	it("rejects policy-violating URLs without network", async () => {
		const fetchImpl = vi.fn();
		const outcome = await runWebFetch({ url: "http://127.0.0.1:8080/x" }, deps(fetchImpl));
		expect(outcome.details[0].status).toBe("error");
		expect(outcome.details[0].errorCode).toBe("blocked-url");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(outcome.text).toContain("ERROR (blocked-url)");
	});

	it("serves offset pagination from the store with a single fetch", async () => {
		const fetchImpl = vi.fn(async () => htmlResponse(articleHtml));
		const d = deps(fetchImpl);
		const first = await runWebFetch({ url: "https://example.com/streams" }, d);
		const second = await runWebFetch(
			{ url: "https://example.com/streams", offset: first.details[0].charCount - 50 },
			d,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(second.details[0].fromCache).toBe(true);
		expect(second.details[0].markdown.length).toBeGreaterThan(0);
		expect(second.details[0].markdown.length).toBeLessThanOrEqual(50);
		expect(second.details[0].truncated).toBe(false);
	});

	it("sets truncation metadata and nextOffset", async () => {
		const fetchImpl = vi.fn(async () => htmlResponse(articleHtml));
		const outcome = await runWebFetch(
			{ url: "https://example.com/streams", maxCharacters: 500 },
			deps(fetchImpl),
		);
		const r = outcome.details[0];
		expect(r.truncated).toBe(true);
		expect(r.nextOffset).toBe(500);
		expect(r.markdown.length).toBeLessThanOrEqual(500);
		expect(outcome.text).toContain("continue with offset: 500");
	});

	it("serves findText from the store", async () => {
		const fetchImpl = vi.fn(async () => htmlResponse(articleHtml));
		const d = deps(fetchImpl);
		await runWebFetch({ url: "https://example.com/streams" }, d);
		const outcome = await runWebFetch(
			{ url: "https://example.com/streams", findText: "backpressure" },
			d,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const r = outcome.details[0];
		expect(r.fromCache).toBe(true);
		expect(outcome.text).toContain('"backpressure" ×');
	});

	it("fetches a cold URL then matches when findText is set", async () => {
		const fetchImpl = vi.fn(async () => htmlResponse(articleHtml));
		const outcome = await runWebFetch(
			{ url: "https://example.com/streams", findText: "backpressure" },
			deps(fetchImpl),
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(outcome.text).toContain("slow consumer");
	});

	it("rejects findText combined with offset", async () => {
		await expect(
			runWebFetch(
				{ url: "https://example.com/x", findText: "a", offset: 100 },
				deps(vi.fn()),
			),
		).rejects.toThrow(/mutually exclusive/);
	});

	it("fresh bypasses the store but overwrites it", async () => {
		const first = vi.fn(async () => htmlResponse("<html><head><title>Old</title></head><body><article><p>" + "old content ".repeat(20) + "</p></article></body></html>"));
		await runWebFetch({ url: "https://example.com/x" }, deps(first));
		const second = vi.fn(async () =>
			htmlResponse("<html><head><title>New</title></head><body><article><p>" + "fresh content ".repeat(20) + "</p></article></body></html>"),
		);
		const outcome = await runWebFetch({ url: "https://example.com/x", fresh: true }, deps(second));
		expect(outcome.details[0].title).toBe("New");
		expect(outcome.details[0].fromCache).toBe(false);
		// Third call (no fresh) hits the store and sees the NEW content
		const third = await runWebFetch({ url: "https://example.com/x" }, deps(vi.fn()));
		expect(third.details[0].fromCache).toBe(true);
		expect(third.details[0].title).toBe("New");
	});

	it("handles batches with mixed success and failure in input order", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("bad")) {
				return new Response("missing", { status: 404 });
			}
			return htmlResponse(articleHtml);
		});
		const outcome = await runWebFetch(
			{ urls: ["https://example.com/a", "https://example.com/bad", "https://example.com/c"] },
			deps(fetchImpl),
		);
		expect(outcome.details.map((r) => r.url)).toEqual([
			"https://example.com/a",
			"https://example.com/bad",
			"https://example.com/c",
		]);
		expect(outcome.details[1].status).toBe("error");
		expect(outcome.details[1].errorCode).toBe("http-error");
		expect(outcome.details[0].status).toBe("ok");
		expect(outcome.details[2].status).toBe("ok");
	});

	it("rejects unsupported content types", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("binary", { status: 200, headers: { "content-type": "application/octet-stream" } }),
		);
		const outcome = await runWebFetch({ url: "https://example.com/blob" }, deps(fetchImpl));
		expect(outcome.details[0].errorCode).toBe("bad-content-type");
		expect(await store.size()).toBe(0); // errors never stored
	});

	it("treats unextractable pages as extraction failures", async () => {
		const fetchImpl = vi.fn(async () => htmlResponse("<html><head><title>S</title></head><body><div id=\"root\"></div></body></html>"));
		const outcome = await runWebFetch({ url: "https://example.com/shell" }, deps(fetchImpl));
		expect(outcome.details[0].errorCode).toBe("extraction-failed");
		expect(await store.size()).toBe(0);
	});

	it("accepts text/plain bodies verbatim", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("plain notes here\nsecond line", { status: 200, headers: { "content-type": "text/plain" } }),
		);
		const outcome = await runWebFetch({ url: "https://example.com/notes.txt" }, deps(fetchImpl));
		expect(outcome.details[0].status).toBe("ok");
		expect(outcome.details[0].markdown).toContain("plain notes here");
	});

	it("strips markdown formatting in text mode", async () => {
		const fetchImpl = vi.fn(async () => htmlResponse(articleHtml));
		const outcome = await runWebFetch(
			{ url: "https://example.com/streams", format: "text" },
			deps(fetchImpl),
		);
		expect(outcome.details[0].markdown).not.toContain("## ");
		expect(outcome.details[0].markdown).not.toContain("](");
		expect(outcome.details[0].markdown).toContain("Backpressure");
	});

	it("requires url or urls", async () => {
		await expect(runWebFetch({}, deps(vi.fn()))).rejects.toThrow(/provide url/);
	});

	it("rejects batches over 8 URLs", async () => {
		const urls = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`);
		await expect(runWebFetch({ urls }, deps(vi.fn()))).rejects.toThrow(/at most 8/);
	});
});

describe("mapWithConcurrency", () => {
	it("preserves input order under concurrency", async () => {
		const items = [5, 1, 3, 2, 4];
		const out = await mapWithConcurrency(items, 2, async (n) => {
			await new Promise((r) => setTimeout(r, n * 5));
			return n * 10;
		});
		expect(out).toEqual([50, 10, 30, 20, 40]);
	});

	it("runs no more than limit tasks at once", async () => {
		let active = 0;
		let peak = 0;
		const items = Array.from({ length: 10 }, (_, i) => i);
		await mapWithConcurrency(items, 3, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 10));
			active--;
			return n;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});
});
