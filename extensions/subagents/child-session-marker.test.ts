import { describe, expect, it } from "vitest";
import { isSubagentChildSession, markSubagentChildSession } from "./child-session-marker.ts";

describe("child session marker", () => {
	it("marks and detects child session managers", () => {
		const manager = {};
		expect(isSubagentChildSession(manager)).toBe(false);
		markSubagentChildSession(manager);
		expect(isSubagentChildSession(manager)).toBe(true);
	});

	it("does not leak between session managers", () => {
		const child = {};
		const root = {};
		markSubagentChildSession(child);
		expect(isSubagentChildSession(root)).toBe(false);
	});
});
