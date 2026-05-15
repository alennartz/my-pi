import { describe, expect, it } from "vitest";
import { formatSpawnToolResult } from "./tool-result.js";

describe("formatSpawnToolResult", () => {
	it("returns only the awaited agent output", () => {
		const waitResult = '<agent_idle id="scout1" status="idle">\nfound it\n</agent_idle>';
		expect(formatSpawnToolResult(waitResult)).toBe(waitResult);
	});

	it("falls back to the completion message when waitResult is empty", () => {
		expect(formatSpawnToolResult("")).toBe(
			"All specified agents have completed. No pending notifications.",
		);
	});
});
