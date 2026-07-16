import { describe, expect, it } from "vitest";
import { resolveChildToolPolicy, type ChildToolPolicyInput } from "./child-tool-policy.js";

function expectExactStableAllowlist(input: ChildToolPolicyInput, expected: string[]) {
	const first = resolveChildToolPolicy(input);
	const second = resolveChildToolPolicy(input);

	expect(first.excludeTools).toBeUndefined();
	expect(first.allowedTools).toBeDefined();
	expect(new Set(first.allowedTools!)).toEqual(new Set(expected));
	expect(first.allowedTools!).toHaveLength(expected.length);
	expect(second).toEqual(first);
}

describe("resolveChildToolPolicy", () => {
	it("gives a default child no allowlist while excluding direct-user prompting", () => {
		expect(resolveChildToolPolicy({ kind: "default" })).toEqual({
			allowedTools: undefined,
			excludeTools: ["ask_user"],
		});
	});

	it("normalizes persona tools into one authoritative, deduplicated SDK allowlist", () => {
		expectExactStableAllowlist({
			kind: "persona",
			tools: ["read", "send", "respond", "send", "ask_user"],
		}, ["read", "send", "respond"]);
	});

	it("keeps an empty persona restriction operational with only infrastructure respond", () => {
		expectExactStableAllowlist({ kind: "persona", tools: [] }, ["respond"]);
	});

	it("preserves exactly the active extension and built-in fork tools while adding infrastructure respond", () => {
		expectExactStableAllowlist({
			kind: "fork",
			parentActiveTools: ["read", "toolscript_custom", "send", "ask_user", "send"],
		}, ["read", "toolscript_custom", "send", "respond"]);
	});
});
