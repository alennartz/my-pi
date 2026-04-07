import { describe, it, expect } from "vitest";
import { matchOverlay, compareSpecificity, sortMatchedOverlays, globToRegex } from "./matching.ts";
import type { OverlayFile } from "./parsing.ts";
import type { MatchResult, IndexedMatchedOverlay } from "./matching.ts";

function makeOverlay(models: string[], path = "/test/AGENTS.test.md"): OverlayFile {
	return { path, dir: "/test", body: "body", models };
}

describe("globToRegex", () => {
	it("matches wildcard patterns", () => {
		expect(globToRegex("claude-*").test("claude-sonnet-4-5")).toBe(true);
		expect(globToRegex("claude-*").test("gpt-4")).toBe(false);
	});

	it("matches exact strings", () => {
		expect(globToRegex("claude-sonnet-4-5").test("claude-sonnet-4-5")).toBe(true);
		expect(globToRegex("claude-sonnet-4-5").test("claude-sonnet-4-5-extra")).toBe(false);
	});

	it("handles regex-special characters like in o3-*", () => {
		expect(globToRegex("o3-*").test("o3-mini")).toBe(true);
		expect(globToRegex("o3.*").test("o3-mini")).toBe(false); // dot is literal
	});

	it("wildcard * matches any model ID", () => {
		expect(globToRegex("*").test("anything-at-all")).toBe(true);
		expect(globToRegex("*").test("")).toBe(true);
	});
});

describe("matchOverlay", () => {
	it("claude-* matches claude-sonnet-4-5", () => {
		const result = matchOverlay("claude-sonnet-4-5", makeOverlay(["claude-*"]));
		expect(result).toEqual({
			matched: true,
			matchingGlob: "claude-*",
			literalChars: 7,
			wildcardCount: 1,
		});
	});

	it("claude-sonnet-* matches claude-sonnet-4-5", () => {
		const result = matchOverlay("claude-sonnet-4-5", makeOverlay(["claude-sonnet-*"]));
		expect(result).toEqual({
			matched: true,
			matchingGlob: "claude-sonnet-*",
			literalChars: 14,
			wildcardCount: 1,
		});
	});

	it("exact match claude-sonnet-4-5", () => {
		const result = matchOverlay("claude-sonnet-4-5", makeOverlay(["claude-sonnet-4-5"]));
		expect(result).toEqual({
			matched: true,
			matchingGlob: "claude-sonnet-4-5",
			literalChars: 17,
			wildcardCount: 0,
		});
	});

	it("gpt-* does NOT match claude-sonnet-4-5", () => {
		const result = matchOverlay("claude-sonnet-4-5", makeOverlay(["gpt-*"]));
		expect(result).toEqual({ matched: false });
	});

	it("multi-glob overlay picks the most specific matching glob", () => {
		const result = matchOverlay("claude-sonnet-4-5", makeOverlay(["claude-*", "claude-sonnet-*"]));
		expect(result).toEqual({
			matched: true,
			matchingGlob: "claude-sonnet-*",
			literalChars: 14,
			wildcardCount: 1,
		});
	});

	it("glob * matches any model ID", () => {
		const result = matchOverlay("anything", makeOverlay(["*"]));
		expect(result).toEqual({
			matched: true,
			matchingGlob: "*",
			literalChars: 0,
			wildcardCount: 1,
		});
	});
});

describe("compareSpecificity", () => {
	it("sorts broad → narrow (ascending literalChars, descending wildcardCount)", () => {
		const a: MatchResult = { matched: true, matchingGlob: "claude-*", literalChars: 7, wildcardCount: 1 };
		const b: MatchResult = { matched: true, matchingGlob: "claude-sonnet-*", literalChars: 14, wildcardCount: 1 };
		const c: MatchResult = { matched: true, matchingGlob: "claude-sonnet-4-5", literalChars: 17, wildcardCount: 0 };

		const sorted = [c, a, b].sort(compareSpecificity);
		expect(sorted.map((s) => s.matchingGlob)).toEqual(["claude-*", "claude-sonnet-*", "claude-sonnet-4-5"]);
	});
});

describe("sortMatchedOverlays", () => {
	it("sorts by root order first, then specificity, then path", () => {
		const overlays: IndexedMatchedOverlay[] = [
			{
				...makeOverlay(["claude-sonnet-*"], "/project/AGENTS.claude-sonnet.md"),
				matched: true,
				matchingGlob: "claude-sonnet-*",
				literalChars: 14,
				wildcardCount: 1,
				rootIndex: 1,
			},
			{
				...makeOverlay(["claude-*"], "/global/AGENTS.claude.md"),
				matched: true,
				matchingGlob: "claude-*",
				literalChars: 7,
				wildcardCount: 1,
				rootIndex: 0,
			},
			{
				...makeOverlay(["claude-*"], "/project/AGENTS.claude.md"),
				matched: true,
				matchingGlob: "claude-*",
				literalChars: 7,
				wildcardCount: 1,
				rootIndex: 1,
			},
		];

		const sorted = sortMatchedOverlays(overlays);
		expect(sorted.map((s) => s.path)).toEqual([
			"/global/AGENTS.claude.md",
			"/project/AGENTS.claude.md",
			"/project/AGENTS.claude-sonnet.md",
		]);
	});

	it("uses path as tie-breaker for same root and specificity", () => {
		const overlays: IndexedMatchedOverlay[] = [
			{
				...makeOverlay(["claude-*"], "/dir/AGENTS.z-claude.md"),
				matched: true,
				matchingGlob: "claude-*",
				literalChars: 7,
				wildcardCount: 1,
				rootIndex: 0,
			},
			{
				...makeOverlay(["claude-*"], "/dir/AGENTS.a-claude.md"),
				matched: true,
				matchingGlob: "claude-*",
				literalChars: 7,
				wildcardCount: 1,
				rootIndex: 0,
			},
		];

		const sorted = sortMatchedOverlays(overlays);
		expect(sorted[0].path).toBe("/dir/AGENTS.a-claude.md");
		expect(sorted[1].path).toBe("/dir/AGENTS.z-claude.md");
	});
});
