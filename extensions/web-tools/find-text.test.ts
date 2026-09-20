import { describe, expect, it } from "vitest";
import { findInText } from "./find-text.js";

function doc(): string {
	return (
		"# Install Guide\n\n".padEnd(0) +
		"The installation section describes how to install the package. " +
		"Run the installer and follow the prompts carefully. ".repeat(3) +
		"\n\n## Configuration\n\n" +
		"Configuration lives in config.json. The installation can be re-run at any time. " +
		"Between configuration and installation there is nothing else to say here, so this " +
		"paragraph exists purely to push the two installation mentions far enough apart that " +
		"their context windows do not overlap in the default configuration of the finder. ".repeat(2)
	);
}

describe("findInText", () => {
	it("finds case-insensitive matches with context and counts", () => {
		const result = findInText(doc(), ["installation"]);
		expect(result.matchCount).toBeGreaterThanOrEqual(3);
		expect(result.perQuery).toEqual([{ query: "installation", matchCount: result.matchCount }]);
		expect(result.text).toContain('"installation" ×');
		expect(result.text).toMatch(/Matches \(\d+ total\)/);
		// context around a match is included
		expect(result.text).toContain("describes how to install");
	});

	it("merges overlapping matches into one passage", () => {
		const text = "aaa installation configuration bbb ".repeat(1) + " ".repeat(1000) + " tail";
		const result = findInText(text, ["installation", "configuration"], { contextChars: 50 });
		// both queries hit within one context window → single passage listing both
		expect(result.text).toContain('"installation" ×1, "configuration" ×1');
	});

	it("renders separate passages for distant matches", () => {
		const far = "start ".padEnd(5) + "matchpoint one" + " filler ".repeat(300) + "matchpoint two end";
		const result = findInText(far, ["matchpoint"], { contextChars: 10 });
		expect(result.text).toContain("1. ");
		expect(result.text).toContain("2. ");
	});

	it("normalizes whitespace inside rendered passages", () => {
		const text = "before\n\n\n\t\t  needle  \n\n\nafter" + " ".repeat(100) + "x";
		const result = findInText(text, ["needle"], { contextChars: 6 });
		expect(result.text).not.toMatch(/\n\t/);
		expect(result.text).toContain("needle");
	});

	it("reports per-query counts and no-match queries", () => {
		const result = findInText("alpha beta gamma", ["alpha", "zeta"]);
		expect(result.perQuery).toEqual([
			{ query: "alpha", matchCount: 1 },
			{ query: "zeta", matchCount: 0 },
		]);
		expect(result.text).toContain('"alpha" ×1');
	});

	it("returns a no-matches message when nothing matches", () => {
		const result = findInText("some content here", ["absent"]);
		expect(result.matchCount).toBe(0);
		expect(result.text).toBe('No matches for: "absent"');
	});

	it("handles empty queries", () => {
		const result = findInText("content", []);
		expect(result.matchCount).toBe(0);
		expect(result.perQuery).toEqual([]);
	});

	it("caps output and reports how many matches were shown", () => {
		const text = Array.from({ length: 200 }, (_, i) => `needle occurrence number ${i} `).join("");
		const result = findInText(text, ["needle"], { contextChars: 5, maxOutputChars: 2000 });
		expect(result.matchCount).toBe(200);
		expect(result.text.length).toBeLessThanOrEqual(2200); // cap + trailing note
		expect(result.text).toMatch(/Showing \d+ of 200 matches\./);
	});

	it("dedupes repeated queries", () => {
		const result = findInText("needle here", ["needle", " needle "]);
		expect(result.perQuery).toHaveLength(1);
		expect(result.matchCount).toBe(1);
	});

	it("trims context at document edges without ellipsis", () => {
		const result = findInText("edge-needle and the rest of this text", ["edge-needle"], {
			contextChars: 100,
		});
		expect(result.text).not.toContain("…");
	});
});
