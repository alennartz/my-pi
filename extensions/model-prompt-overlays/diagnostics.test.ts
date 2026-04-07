import { describe, it, expect } from "vitest";
import { createDiagnosticsTracker } from "./diagnostics.ts";

describe("createDiagnosticsTracker", () => {
	it("returns true on first occurrence of a path+message pair", () => {
		const tracker = createDiagnosticsTracker();
		expect(tracker.shouldNotify("/a.md", "bad field")).toBe(true);
	});

	it("returns false on second identical call", () => {
		const tracker = createDiagnosticsTracker();
		tracker.shouldNotify("/a.md", "bad field");
		expect(tracker.shouldNotify("/a.md", "bad field")).toBe(false);
	});

	it("returns true for different message on same path", () => {
		const tracker = createDiagnosticsTracker();
		tracker.shouldNotify("/a.md", "bad field");
		expect(tracker.shouldNotify("/a.md", "missing models")).toBe(true);
	});

	it("returns true for different path with same message", () => {
		const tracker = createDiagnosticsTracker();
		tracker.shouldNotify("/a.md", "bad field");
		expect(tracker.shouldNotify("/b.md", "bad field")).toBe(true);
	});
});
