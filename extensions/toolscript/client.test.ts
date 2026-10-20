import { describe, expect, it } from "vitest";
import { errorResult, extractBlocks, hasSchemaRefs, wrapResultSchema } from "./client.ts";

describe("extractBlocks", () => {
	it("maps text and image blocks, preserving order", () => {
		const raw = [
			{ type: "text", text: "one" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: "two" },
		];
		expect(extractBlocks(raw)).toEqual([
			{ type: "text", text: "one" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: "two" },
		]);
	});

	it("skips block types it cannot map and malformed entries", () => {
		const raw = [
			{ type: "resource_link", uri: "file:///x" },
			{ type: "text" },
			{ type: "image", data: 42, mimeType: "image/png" },
			null,
			"plain",
		];
		expect(extractBlocks(raw)).toEqual([]);
	});

	it("accepts non-array content", () => {
		expect(extractBlocks(undefined)).toEqual([]);
		expect(extractBlocks({ type: "text", text: "x" })).toEqual([]);
	});
});

describe("errorResult", () => {
	it("builds one text block, mirrored as raw content, marked as error", () => {
		const result = errorResult("boom");
		expect(result.blocks).toEqual([{ type: "text", text: "boom" }]);
		expect(result.rawContent).toEqual([{ type: "text", text: "boom" }]);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
	});
});

describe("hasSchemaRefs", () => {
	it("rejects a schema without refs", () => {
		expect(hasSchemaRefs({ type: "object", properties: { count: { type: "number" } } })).toBe(false);
	});

	it("finds $ref and $defs at any depth, including arrays", () => {
		expect(hasSchemaRefs({ properties: { item: { $ref: "#/$defs/Item" } } })).toBe(true);
		expect(hasSchemaRefs({ $defs: { Item: { type: "string" } } })).toBe(true);
		expect(hasSchemaRefs([{ type: "string" }, { anyOf: [{ $ref: "#" }] }])).toBe(true);
	});
});

describe("wrapResultSchema", () => {
	it("declares content, structuredContent, and isError with only content required", () => {
		const schema = wrapResultSchema();
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["content"]);
		expect(schema.additionalProperties).toBe(true);
		expect(schema.properties.content.type).toBe("array");
		expect(schema.properties.structuredContent).toEqual({});
		expect(schema.properties.isError).toEqual({ type: "boolean" });
	});

	it("describes the text and image block shapes", () => {
		const schema = wrapResultSchema();
		const items = schema.properties.content.items as { anyOf: Array<Record<string, any>> };
		expect(items.anyOf).toHaveLength(2);
		expect(items.anyOf[0].properties.type).toEqual({ type: "string", const: "text" });
		expect(items.anyOf[1].properties.type).toEqual({ type: "string", const: "image" });
		expect(items.anyOf[1].required).toEqual(["type", "data", "mimeType"]);
	});

	it("uses the upstream outputSchema for structuredContent when it has no refs", () => {
		const upstream = { type: "object", properties: { count: { type: "number" } } };
		const schema = wrapResultSchema(upstream);
		expect(schema.properties.structuredContent).toEqual(upstream);
	});

	it("falls back to {} when the upstream schema carries refs", () => {
		const schema = wrapResultSchema({ type: "object", $defs: { Item: { type: "string" } } });
		expect(schema.properties.structuredContent).toEqual({});
		const refSchema = wrapResultSchema({ type: "object", properties: { item: { $ref: "#/$defs/Item" } } });
		expect(refSchema.properties.structuredContent).toEqual({});
	});
});
