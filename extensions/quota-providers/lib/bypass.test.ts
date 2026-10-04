import { describe, it, expect } from "vitest";
import {
	createSessionTreeStore,
	registerSessionIdTreeStore,
	unregisterSessionIdTreeStore,
} from "../../subagents/scoped-store.js";
import { BYPASS_KEY, readBypass, resolveRequestStore, writeBypass } from "./bypass.js";

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

describe("resolveRequestStore", () => {
	it("prefers the requesting session's tree over a captured fallback", () => {
		// Regression: a provider closure can outlive its session (shared model
		// runtime), so its captured store may belong to another tree. The
		// request's own tree must win.
		const requestTree = createSessionTreeStore();
		const capturedTree = createSessionTreeStore();
		writeBypass(requestTree, true);
		registerSessionIdTreeStore("session-1", requestTree);
		try {
			const store = resolveRequestStore("session-1", capturedTree);
			expect(store).toBe(requestTree);
			expect(readBypass(store!)).toBe(true);
		} finally {
			unregisterSessionIdTreeStore("session-1", requestTree);
		}
	});

	it("falls back to the captured store for an unknown session id", () => {
		const capturedTree = createSessionTreeStore();
		expect(resolveRequestStore("session-unknown", capturedTree)).toBe(capturedTree);
	});

	it("falls back to the captured store when the request carries no session id", () => {
		const capturedTree = createSessionTreeStore();
		expect(resolveRequestStore(undefined, capturedTree)).toBe(capturedTree);
		expect(resolveRequestStore(undefined, undefined)).toBeUndefined();
	});
});
