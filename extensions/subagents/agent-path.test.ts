import { describe, expect, it } from "vitest";
import { childAgentPath, formatAgentPath, qualifiedAgentId, type AgentPath } from "./agent-path.js";

describe("canonical agent paths", () => {
	it("represents the external root as an empty path", () => {
		const root: AgentPath = [];
		expect(formatAgentPath(root)).toBe("");
		expect(childAgentPath(root, "researcher")).toEqual(["researcher"]);
	});

	it("appends a local sibling id without mutating the parent path", () => {
		const parent: AgentPath = ["researcher"];
		const child = childAgentPath(parent, "scout");

		expect(child).toEqual(["researcher", "scout"]);
		expect(parent).toEqual(["researcher"]);
		expect(child).not.toBe(parent);
	});

	it("formats nested segments in their canonical order deterministically", () => {
		const first = formatAgentPath(["researcher", "scout"]);
		expect(first).toContain("researcher");
		expect(first).toContain("scout");
		expect(first).toBe(formatAgentPath(["researcher", "scout"]));
		expect(first).not.toBe(formatAgentPath(["scout", "researcher"]));
	});

	it("escapes a segment so delimiter-bearing ids cannot collide with separate segments", () => {
		const oneSegment = formatAgentPath(["a/b"]);
		const twoSegments = formatAgentPath(["a", "b"]);

		expect(oneSegment).not.toBe(twoSegments);
		expect(oneSegment).toContain("a");
		expect(oneSegment).toContain("b");
	});

	it("qualifies a descendant relative to its owner so the trail shows tree depth", () => {
		expect(qualifiedAgentId([], ["worker"])).toBe("worker");
		expect(qualifiedAgentId([], ["worker", "scout"])).toBe("worker/scout");
		expect(qualifiedAgentId(["worker"], ["worker", "scout", "probe"])).toBe("scout/probe");
	});

	it("returns no qualified id for a path that is not below the owner", () => {
		expect(qualifiedAgentId(["worker"], ["worker"])).toBe("");
		expect(qualifiedAgentId(["worker"], ["other", "scout"])).toBe("");
		expect(qualifiedAgentId(["worker"], [])).toBe("");
	});
});
