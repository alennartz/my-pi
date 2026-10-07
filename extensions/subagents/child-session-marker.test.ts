import { describe, expect, it } from "vitest";
import {
	getSubagentPersona,
	isSubagentChildSession,
	markSubagentChildSession,
} from "./child-session-marker.ts";

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

describe("subagent persona payload", () => {
	it("returns the payload recorded when the child session was marked", () => {
		const manager = {};
		markSubagentChildSession(manager, { name: "scout", body: "You are a scout." });

		expect(getSubagentPersona(manager)).toEqual({ name: "scout", body: "You are a scout." });
	});

	it("returns undefined for a child marked without a payload", () => {
		const manager = {};
		markSubagentChildSession(manager);

		expect(getSubagentPersona(manager)).toBeUndefined();
	});

	it("returns undefined for a session manager that is not a subagent child", () => {
		expect(getSubagentPersona({})).toBeUndefined();
	});

	it("does not leak payloads between session managers", () => {
		const first = {};
		const second = {};
		markSubagentChildSession(first, { name: "scout", body: "You are a scout." });
		markSubagentChildSession(second);

		expect(getSubagentPersona(second)).toBeUndefined();
	});
});
