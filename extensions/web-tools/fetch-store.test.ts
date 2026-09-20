import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKeyFor, openFetchStore } from "./fetch-store.js";
import { okFetchResult, errorFetchResult } from "./types.js";

let dir: string;
let nowMs: number;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "web-tools-store-"));
	nowMs = 1_000_000;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function okResult(markdown: string, url = "https://example.com/a") {
	return okFetchResult({
		url,
		effectiveUrl: url,
		title: "T",
		markdown,
		contentHash: "h" + markdown.length,
		attempts: 1,
		fromCache: false,
	});
}

const clock = () => nowMs;

describe("FetchStore", () => {
	it("round-trips full untruncated markdown", async () => {
		const store = openFetchStore(dir, { now: clock });
		const long = "x".repeat(100_000);
		await store.put("k1", okResult(long));
		const hit = await store.get("k1");
		expect(hit).not.toBeNull();
		expect(hit!.result.markdown).toBe(long);
		expect(hit!.result.charCount).toBe(100_000);
	});

	it("returns null on miss", async () => {
		const store = openFetchStore(dir, { now: clock });
		expect(await store.get("missing")).toBeNull();
	});

	it("deletes expired entries lazily on read", async () => {
		const store = openFetchStore(dir, { ttlMs: 1000, now: clock });
		await store.put("k1", okResult("content"));
		nowMs += 2000;
		expect(await store.get("k1")).toBeNull();
		expect(await store.size()).toBe(0);
	});

	it("does not store error results", async () => {
		const store = openFetchStore(dir, { now: clock });
		await store.put("k1", errorFetchResult("https://example.com/a", "http-error", "404"));
		expect(await store.get("k1")).toBeNull();
		expect(await store.size()).toBe(0);
	});

	it("prunes oldest entries past maxEntries after write", async () => {
		const store = openFetchStore(dir, { maxEntries: 3, now: clock });
		for (let i = 0; i < 5; i++) {
			await store.put(`k${i}`, okResult("c" + i, `https://example.com/${i}`));
			nowMs += 1000; // distinct mtimes
		}
		expect(await store.size()).toBe(3);
		expect(await store.get("k0")).toBeNull(); // oldest pruned
		expect(await store.get("k1")).toBeNull();
		expect((await store.get("k4"))!.result.markdown).toBe("c4");
	});

	it("leaves no temp files after successful puts", async () => {
		const store = openFetchStore(dir, { now: clock });
		await store.put("k1", okResult("content"));
		const names = await readdir(dir);
		expect(names.filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	it("treats corrupt entries as misses and removes them", async () => {
		const store = openFetchStore(dir, { now: clock });
		await store.put("k1", okResult("content"));
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(dir, "k1.json"), "{not json", "utf-8");
		expect(await store.get("k1")).toBeNull();
		expect(await store.size()).toBe(0);
	});

	it("clear removes everything", async () => {
		const store = openFetchStore(dir, { now: clock });
		await store.put("k1", okResult("content"));
		await store.clear();
		expect(await store.size()).toBe(0);
	});
});

describe("cacheKeyFor", () => {
	it("hashes url plus extraction options", () => {
		const a = cacheKeyFor("https://example.com/a");
		const b = cacheKeyFor("https://example.com/a", "opts1");
		const c = cacheKeyFor("https://example.com/b");
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
	});
});
