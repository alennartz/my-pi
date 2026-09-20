import { describe, expect, it } from "vitest";
import { TtlLruCache } from "./cache.js";
import { newResponseId } from "./response-id.js";

describe("TtlLruCache", () => {
	it("stores and returns values", () => {
		const cache = new TtlLruCache<string>(60_000, 10);
		cache.set("k", "v");
		expect(cache.get("k")).toBe("v");
		expect(cache.size).toBe(1);
	});

	it("expires entries after the TTL", () => {
		let t = 0;
		const cache = new TtlLruCache<string>(20, 10, () => t);
		cache.set("k", "v");
		t = 15;
		expect(cache.get("k")).toBe("v"); // still fresh
		t = 25;
		expect(cache.get("k")).toBeUndefined(); // expired
		expect(cache.size).toBe(0);
	});

	it("evicts least-recently-used entries at capacity", () => {
		const cache = new TtlLruCache<string>(60_000, 3);
		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3");
		cache.get("a"); // refresh a — b is now LRU
		cache.set("d", "4");
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("1");
		expect(cache.get("c")).toBe("3");
		expect(cache.get("d")).toBe("4");
		expect(cache.size).toBe(3);
	});

	it("clear empties the cache", () => {
		const cache = new TtlLruCache<string>(60_000, 10);
		cache.set("k", "v");
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get("k")).toBeUndefined();
	});
});

describe("newResponseId", () => {
	it("returns short unique hex ids", () => {
		const a = newResponseId();
		const b = newResponseId();
		expect(a).toMatch(/^[0-9a-f]{12}$/);
		expect(a).not.toBe(b);
	});
});
