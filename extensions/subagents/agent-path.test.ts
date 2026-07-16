import { describe, expect, it } from "vitest";
import { childAgentPath, formatAgentPath, type AgentPath } from "./agent-path.js";

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

	it("formats nested segments in their canonical order", () => {
		expect(formatAgentPath(["researcher", "scout"])).toContain("researcher");
		expect(formatAgentPath(["researcher", "scout"])).toContain("scout");
		expect(formatAgentPath(["researcher", "scout"])).not.toBe(formatAgentPath(["scout", "researcher"]));
	});

	it("escapes a segment so delimiter-bearing ids cannot collide with separate segments", () => {
		const oneSegment = formatAgentPath(["a/b"]);
		const twoSegments = formatAgentPath(["a", "b"]);

		expect(oneSegment).not.toBe(twoSegments);
		expect(oneSegment).toContain("a");
		expect(oneSegment).toContain("b");
	});
});
