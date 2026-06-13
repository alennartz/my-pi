import { describe, expect, it } from "vitest";
import { addToTopology, buildTopology, canSend, validateTopology } from "./channels.js";

describe("validateTopology", () => {
	it("accepts channels that reference batch peers or parent", () => {
		expect(validateTopology([
			{ id: "a", channels: ["b", "parent"] },
			{ id: "b", channels: [] },
		])).toBeNull();
	});

	it("flags channels that reference unknown peers", () => {
		const error = validateTopology([
			{ id: "a", channels: ["nonexistent"] },
		]);
		expect(error).toMatch(/references unknown peer "nonexistent"/);
	});
});

describe("addToTopology", () => {
	it('accepts "parent" in declared channels for incremental batches', () => {
		const topology = buildTopology([{ id: "a", channels: [] }]);
		expect(() => addToTopology(
			topology,
			[{ id: "b", channels: ["a", "parent"] }],
			new Set(["a"]),
			new Set(),
		)).not.toThrow();
		expect(canSend(topology, "b", "a")).toBe(true);
		expect(canSend(topology, "b", "parent")).toBe(true);
	});

	it("rejects unknown peers in incremental batches", () => {
		const topology = buildTopology([{ id: "a", channels: [] }]);
		expect(() => addToTopology(
			topology,
			[{ id: "b", channels: ["ghost"] }],
			new Set(["a"]),
			new Set(),
		)).toThrow(/unknown peer "ghost"/);
	});
});
