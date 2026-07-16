import { describe, expect, it } from "vitest";
import { resolveChildToolPolicy } from "./child-tool-policy.js";

describe("resolveChildToolPolicy", () => {
	it("gives a default child no allowlist while excluding direct-user prompting", () => {
		expect(resolveChildToolPolicy({ kind: "default" })).toEqual({
			allowedTools: undefined,
			excludeTools: ["ask_user"],
		});
	});

	it("normalizes persona tools into one deduplicated SDK allowlist", () => {
		const policy = resolveChildToolPolicy({
			kind: "persona",
			tools: ["read", "send", "respond", "send", "ask_user"],
		});

		expect(policy.excludeTools).toBeUndefined();
		expect(policy.allowedTools).toBeDefined();
		const allowedTools = policy.allowedTools!;
		expect(allowedTools).toEqual(expect.arrayContaining(["read", "send", "respond"]));
		expect(allowedTools).not.toContain("ask_user");
		expect(new Set(allowedTools).size).toBe(allowedTools.length);
	});

	it("preserves extension and built-in tools from a fork while adding infrastructure respond", () => {
		const policy = resolveChildToolPolicy({
			kind: "fork",
			parentActiveTools: ["read", "toolscript_custom", "send", "ask_user", "send"],
		});

		expect(policy.excludeTools).toBeUndefined();
		expect(policy.allowedTools).toBeDefined();
		const allowedTools = policy.allowedTools!;
		expect(allowedTools).toEqual(expect.arrayContaining(["read", "toolscript_custom", "send", "respond"]));
		expect(allowedTools).not.toContain("ask_user");
		expect(new Set(allowedTools).size).toBe(allowedTools.length);
	});
});
