import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { dropEmptyOptionals, registerLooseTool } from "./tool-args.ts";

describe("dropEmptyOptionals", () => {
	const schema = Type.Object({
		// Optional per-type coverage
		text: Type.Optional(Type.String()),
		flag: Type.Optional(Type.Boolean()),
		items: Type.Optional(Type.Array(Type.String())),
		count: Type.Optional(Type.Number()),
		// Required: never dropped
		required: Type.String(),
	});

	it("drops optional empty-string, false, and empty-array values", () => {
		expect(
			dropEmptyOptionals(schema, { text: "", flag: false, items: [], required: "keep" }),
		).toEqual({ required: "keep" });
	});

	it("keeps non-empty optional values", () => {
		expect(
			dropEmptyOptionals(schema, { text: "x", flag: true, items: ["a"], count: 0, required: "keep" }),
		).toEqual({ text: "x", flag: true, items: ["a"], count: 0, required: "keep" });
	});

	it("keeps a number zero: numeric values carry information", () => {
		expect(dropEmptyOptionals(schema, { count: 0, required: "keep" })).toEqual({
			count: 0,
			required: "keep",
		});
	});

	it("drops an empty string even for a number-typed param (unset, not zero)", () => {
		expect(dropEmptyOptionals(schema, { count: "", required: "keep" })).toEqual({ required: "keep" });
	});

	it("never drops required properties", () => {
		expect(dropEmptyOptionals(schema, { required: "" })).toEqual({ required: "" });
	});

	it("normalizes nested optional fields inside arrays of objects", () => {
		const itemSchema = Type.Object({
			agents: Type.Array(
				Type.Object({
					id: Type.String(),
					agent: Type.Optional(Type.String()),
					channels: Type.Optional(Type.Array(Type.String())),
				}),
			),
		});
		expect(
			dropEmptyOptionals(itemSchema, {
				agents: [{ id: "a", agent: "", channels: [] }, { id: "b", agent: "scout" }],
			}),
		).toEqual({ agents: [{ id: "a" }, { id: "b", agent: "scout" }] });
	});

	it("handles unions: degenerate values of any member are dropped", () => {
		const unionSchema = Type.Object({
			findText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
		});
		expect(dropEmptyOptionals(unionSchema, { findText: "" })).toEqual({});
		expect(dropEmptyOptionals(unionSchema, { findText: [] })).toEqual({});
		expect(dropEmptyOptionals(unionSchema, { findText: ["goal"] })).toEqual({ findText: ["goal"] });
	});

	it("passes through undeclared keys and non-object args untouched", () => {
		expect(dropEmptyOptionals(schema, { extra: "x" } as any)).toEqual({ extra: "x" });
		expect(dropEmptyOptionals(schema, null)).toEqual(null);
		expect(dropEmptyOptionals(schema, "raw")).toEqual("raw");
	});

	it("does not mutate the input object", () => {
		const args = { text: "", nested: { items: [] }, required: "keep" };
		const nestedSchema = Type.Object({
			text: Type.Optional(Type.String()),
			nested: Type.Object({ items: Type.Optional(Type.Array(Type.String())) }),
			required: Type.String(),
		});
		dropEmptyOptionals(nestedSchema, args);
		expect(args).toEqual({ text: "", nested: { items: [] }, required: "keep" });
	});
});

describe("registerLooseTool", () => {
	it("registers the definition with prepareArguments wired to the schema", () => {
		const pi = { registerTool: vi.fn() };
		const parameters = Type.Object({
			agent: Type.Optional(Type.String()),
		});
		registerLooseTool(pi as any, {
			name: "demo",
			label: "Demo",
			description: "demo tool",
			parameters,
			execute: async () => ({ content: [] }),
		});

		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		const registered = pi.registerTool.mock.calls[0][0];
		expect(registered.name).toBe("demo");
		expect(registered.prepareArguments({ agent: "" })).toEqual({});
		expect(registered.prepareArguments({ agent: "worker" })).toEqual({ agent: "worker" });
	});
});
