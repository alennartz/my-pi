import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OUTPUT_MAX_BYTES, truncateForModel, truncateMiddle } from "./truncate.ts";

describe("truncateMiddle", () => {
	it("returns content unchanged below the limit", () => {
		const result = truncateMiddle("short", 100);
		expect(result).toEqual({
			content: "short",
			truncated: false,
			removedChars: 0,
			totalBytes: 5,
			totalLines: 1,
		});
	});

	it("keeps head and tail around the pi marker above the limit", () => {
		const text = "a".repeat(60) + "MIDDLE" + "b".repeat(60);
		const result = truncateMiddle(text, 32);
		expect(result.truncated).toBe(true);
		expect(result.content).toMatch(/^a+…\d+ chars truncated…b+$/);
		expect(result.content).toContain("…");
		// Head and tail halves are equal: floor(32/2) each.
		const [head, tail] = result.content.split(/…\d+ chars truncated…/);
		expect(head.length).toBe(16);
		expect(tail.length).toBe(16);
		expect(result.removedChars).toBe(6 + 120 - 32);
		expect(result.totalBytes).toBe(126);
	});

	it("never splits multi-byte characters", () => {
		// Each é is 2 bytes; a byte cut at an odd index would land mid-character.
		const text = "é".repeat(50);
		const result = truncateMiddle(text, 21);
		expect(result.truncated).toBe(true);
		expect(result.content).not.toContain("\uFFFD");
		expect(result.content.startsWith("é")).toBe(true);
		expect(result.content.endsWith("é")).toBe(true);
	});

	it("counts lines like pi: trailing newline does not add a line", () => {
		expect(truncateMiddle("a\nb\nc", 100).totalLines).toBe(3);
		expect(truncateMiddle("a\nb\nc\n", 100).totalLines).toBe(3);
		expect(truncateMiddle("", 100).totalLines).toBe(0);
	});

	it("matches pi's default cap of 20 KiB", () => {
		expect(OUTPUT_MAX_BYTES).toBe(20 * 1024);
		const result = truncateMiddle("x".repeat(OUTPUT_MAX_BYTES + 1));
		expect(result.truncated).toBe(true);
		expect(truncateMiddle("x".repeat(OUTPUT_MAX_BYTES)).truncated).toBe(false);
	});
});

describe("truncateForModel", () => {
	it("returns the original text untouched when it fits", async () => {
		const result = await truncateForModel("fits");
		expect(result).toEqual({ text: "fits", truncated: false, removedChars: 0, totalBytes: 4 });
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("truncates, saves the full text to a temp file, and names the path", async () => {
		const full = "HEAD".repeat(6000) + "TAIL".repeat(6000);
		const result = await truncateForModel(full);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		// Notice mirrors pi's MCP bridge format.
		expect(result.text).toMatch(/^Warning: truncated output \(original token count: \d+\)\n/);
		expect(result.text).toContain("Total output lines: 1");
		expect(result.text).toContain(`[Full output: ${result.fullOutputPath} (read it with offset/limit)]`);
		// The saved file holds the complete text.
		expect(await readFile(result.fullOutputPath!, "utf8")).toBe(full);
		expect((await stat(result.fullOutputPath!)).isFile()).toBe(true);
	});

	it("still returns bounded text when the temp file cannot be written", async () => {
		// A path component that is not a directory makes mkdtemp fail.
		const bogus = { maxBytes: 10, suffix: "/dev/null/impossible.txt" };
		const result = await truncateForModel("longer than ten bytes", bogus);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("chars truncated…");
		expect(result.text).toMatch(/\[Could not save the full output: .+\]$/);
		expect(result.fullOutputPath).toBeUndefined();
	});
});
