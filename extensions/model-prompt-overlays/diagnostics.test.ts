import { describe, it, expect } from "vitest";
import { createDiagnosticsTracker } from "./diagnostics.ts";

describe("createDiagnosticsTracker", () => {
	it("returns true on first occurrence of a message", () => {
		const tracker = createDiagnosticsTracker();
		expect(tracker.shouldNotify("bad field: /a.md")).toBe(true);
	});

	it("returns false on second identical call", () => {
		const tracker = createDiagnosticsTracker();
		tracker.shouldNotify("bad field: /a.md");
		expect(tracker.shouldNotify("bad field: /a.md")).toBe(false);
	});

	it("returns true for a different message", () => {
		const tracker = createDiagnosticsTracker();
		tracker.shouldNotify("bad field: /a.md");
		expect(tracker.shouldNotify("missing models: /a.md")).toBe(true);
	});

	it("returns true for the same problem on a different path (path embedded in message)", () => {
		const tracker = createDiagnosticsTracker();
		tracker.shouldNotify("bad field: /a.md");
		expect(tracker.shouldNotify("bad field: /b.md")).toBe(true);
	});
});
