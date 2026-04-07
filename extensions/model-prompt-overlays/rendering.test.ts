import { describe, it, expect } from "vitest";
import { renderOverlayAppendBlock } from "./rendering.ts";
import type { MatchedOverlay } from "./matching.ts";

function makeMatch(path: string, body: string): MatchedOverlay {
	return {
		path,
		dir: "/test",
		body,
		models: ["*"],
		matched: true,
		matchingGlob: "*",
		literalChars: 0,
		wildcardCount: 1,
	};
}

describe("renderOverlayAppendBlock", () => {
	it("returns undefined for empty matches", () => {
		expect(renderOverlayAppendBlock([])).toBeUndefined();
	});

	it("renders a single overlay correctly", () => {
		const result = renderOverlayAppendBlock([
			makeMatch("/home/user/.pi/agent/AGENTS.claude.md", "Be concise with Claude."),
		]);

		expect(result).toBe(
			"# Model-Specific Prompt Overlays\n\n" +
			"## /home/user/.pi/agent/AGENTS.claude.md\n\n" +
			"Be concise with Claude.",
		);
	});

	it("renders multiple overlays in input order", () => {
		const result = renderOverlayAppendBlock([
			makeMatch("/home/user/.pi/agent/AGENTS.claude.md", "Global Claude guidance"),
			makeMatch("/home/user/project/AGENTS.claude-sonnet.md", "Project Sonnet guidance"),
		]);

		expect(result).toContain("## /home/user/.pi/agent/AGENTS.claude.md");
		expect(result).toContain("## /home/user/project/AGENTS.claude-sonnet.md");
		// Global comes before project in the string
		const globalIdx = result!.indexOf("AGENTS.claude.md");
		const projectIdx = result!.indexOf("AGENTS.claude-sonnet.md");
		expect(globalIdx).toBeLessThan(projectIdx);
	});

	it("trims trailing whitespace from body", () => {
		const result = renderOverlayAppendBlock([
			makeMatch("/test/AGENTS.test.md", "Body text\n\n\n"),
		]);

		expect(result).toBe(
			"# Model-Specific Prompt Overlays\n\n" +
			"## /test/AGENTS.test.md\n\n" +
			"Body text",
		);
	});
});
