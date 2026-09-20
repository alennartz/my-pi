import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractContent } from "./extract.js";

const fixtures = join(import.meta.dirname, "fixtures");

function load(name: string): string {
	return readFileSync(join(fixtures, name), "utf-8");
}

describe("extractContent", () => {
	it("extracts a normal article via Readability, preserving headings, links, and code", () => {
		const result = extractContent(load("article.html"), "https://example.com/streams");
		expect(result.engine).toBe("readability");
		expect(result.title).toBe("Understanding Node Streams");
		// Readability separates the article title from body content (the tool
		// layer re-attaches it), so the body starts with prose, not the h1.
		expect(result.markdown).toContain("Node streams are one of the most misunderstood");
		expect(result.markdown).toContain("## Backpressure");
		expect(result.markdown).toContain("[official documentation](https://nodejs.org/api/stream.html)");
		expect(result.markdown).toContain("```");
		expect(result.markdown).toContain("createReadStream");
		expect(result.wordCount).toBeGreaterThan(50);
		expect(result.quality.signals).toEqual([]);
		expect(result.quality.score).toBe(100);
		// nav/footer noise dropped
		expect(result.markdown).not.toContain("Home");
		expect(result.markdown).not.toContain("© 2026");
	});

	it("falls back to DOM extraction when Readability refuses the page", () => {
		const result = extractContent(load("fallback.html"), "https://example.com/fallback");
		expect(result.engine).toBe("dom-fallback");
		expect(result.title).toBe("Fallback Page");
		expect(result.markdown).toContain("A Page Hidden From Readability");
		expect(result.markdown).toContain("fall back to the DOM path");
		expect(result.wordCount).toBeGreaterThan(50);
	});

	it("flags a cookie wall stub", () => {
		const result = extractContent(load("cookie-wall.html"), "https://example.com/paywalled");
		expect(result.quality.signals).toContain("cookie-wall");
		expect(result.quality.score).toBeLessThan(60);
	});

	it("flags a script-heavy empty shell with both signals", () => {
		const result = extractContent(load("shell.html"), "https://example.com/spa");
		expect(result.quality.signals).toContain("empty");
		expect(result.quality.signals).toContain("script-heavy");
		expect(result.quality.score).toBe(0);
	});

	it("preserves tables and fenced code from a docs page", () => {
		const result = extractContent(load("docs.html"), "https://example.com/docs");
		expect(result.engine).toBe("readability");
		expect(result.markdown).toContain("| Event | Description |");
		expect(result.markdown).toContain("| data | Emitted for each chunk |");
		expect(result.markdown).toContain("```");
		expect(result.markdown).toContain("new Readable");
		expect(result.markdown).toContain("[Writable](https://example.com/api/writable)");
	});

	it("produces an empty result with an empty signal for blank documents", () => {
		const result = extractContent("<html><body></body></html>", "https://example.com/empty");
		expect(result.markdown).toBe("");
		expect(result.wordCount).toBe(0);
		expect(result.quality.signals).toContain("empty");
		expect(result.quality.score).toBe(0);
	});
});
