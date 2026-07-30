import { describe, it, expect } from "vitest";
import { createSessionTreeStore } from "../../subagents/scoped-store.js";
import { BYPASS_KEY, readBypass, writeBypass } from "./bypass.js";

describe("tree-scoped quota bypass", () => {
	it("treats an absent value as disabled", () => {
		const store = createSessionTreeStore();
		expect(readBypass(store)).toBe(false);
	});

	it("stores a boolean in the shared tree store", () => {
		const store = createSessionTreeStore();
		writeBypass(store, true);
		expect(store.get(BYPASS_KEY)).toBe(true);
		expect(readBypass(store)).toBe(true);
	});

	it("removes the key when disabled", () => {
		const store = createSessionTreeStore();
		writeBypass(store, true);
		writeBypass(store, false);
		expect(store.get(BYPASS_KEY)).toBeUndefined();
		expect(readBypass(store)).toBe(false);
	});

	it("does not share values between stores", () => {
		const first = createSessionTreeStore();
		const second = createSessionTreeStore();
		writeBypass(first, true);
		expect(readBypass(first)).toBe(true);
		expect(readBypass(second)).toBe(false);
	});
});
