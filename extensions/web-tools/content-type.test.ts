import { describe, expect, it } from "vitest";
import { classifyContentType } from "./content-type.js";

describe("classifyContentType", () => {
	it("sends HTML-like media types to extraction", () => {
		expect(classifyContentType("text/html")).toBe("html");
		expect(classifyContentType("text/html; charset=utf-8")).toBe("html");
		expect(classifyContentType("application/xhtml+xml")).toBe("html");
	});

	it("sends markdown media types through as text", () => {
		expect(classifyContentType("text/markdown")).toBe("text");
		expect(classifyContentType("text/markdown; charset=utf-8")).toBe("text");
		expect(classifyContentType("text/x-markdown")).toBe("text");
		expect(classifyContentType("application/markdown")).toBe("text");
	});

	it("sends structured text media types through as text", () => {
		expect(classifyContentType("text/plain")).toBe("text");
		expect(classifyContentType("text/csv")).toBe("text");
		expect(classifyContentType("application/json")).toBe("text");
		expect(classifyContentType("application/vnd.api+json")).toBe("text");
		expect(classifyContentType("application/xml")).toBe("text");
		expect(classifyContentType("application/rss+xml")).toBe("text");
		expect(classifyContentType("application/yaml")).toBe("text");
		expect(classifyContentType("application/toml")).toBe("text");
		expect(classifyContentType("application/javascript")).toBe("text");
	});

	it("rejects binary media types", () => {
		expect(classifyContentType("application/octet-stream")).toBe("binary");
		expect(classifyContentType("application/pdf")).toBe("binary");
		expect(classifyContentType("image/png")).toBe("binary");
		expect(classifyContentType("font/woff2")).toBe("binary");
	});

	it("rejects a missing content type", () => {
		expect(classifyContentType("")).toBe("binary");
	});
});
