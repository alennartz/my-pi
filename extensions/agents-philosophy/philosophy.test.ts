import { describe, expect, it } from "vitest";
import { AGENTS_MD_SECTION_TAG, renderAgentsMdPhilosophy } from "./philosophy.ts";

describe("renderAgentsMdPhilosophy", () => {
	const text = renderAgentsMdPhilosophy();

	it("is stable across calls (pure)", () => {
		expect(renderAgentsMdPhilosophy()).toBe(text);
	});

	it("states both required parts: vision statement and lookup table", () => {
		expect(text).toContain("vision statement");
		expect(text).toContain("lookup table");
	});

	it("keeps detail out of AGENTS.md itself", () => {
		expect(text).toMatch(/dedicated file/);
	});

	it("uses a valid system prompt section tag", () => {
		expect(AGENTS_MD_SECTION_TAG).toMatch(/^[a-z][a-z0-9_-]*$/);
	});
});
