import { describe, expect, it } from "vitest";
import {
	createSessionTreeStore,
	getOrCreateSessionTreeStore,
	getSessionIdTreeStore,
	getSessionTreeStore,
	registerSessionIdTreeStore,
	registerSessionTreeStore,
	unregisterSessionIdTreeStore,
	unregisterSessionTreeStore,
} from "./scoped-store.js";

describe("scoped session-tree store", () => {
	it("keeps values isolated between independent stores", () => {
		const first = createSessionTreeStore();
		const second = createSessionTreeStore();
		first.set("key", true);

		expect(first.get("key")).toBe(true);
		expect(second.get("key")).toBeUndefined();
	});

	it("shares one store across session managers registered to a tree", () => {
		const rootManager = {};
		const childManager = {};
		const store = createSessionTreeStore();
		registerSessionTreeStore(rootManager, store);
		registerSessionTreeStore(childManager, store);

		getSessionTreeStore(rootManager)?.set("key", true);
		expect(getSessionTreeStore(childManager)?.get("key")).toBe(true);
	});

	it("lazily creates one store per manager", () => {
		const manager = {};
		const first = getOrCreateSessionTreeStore(manager);
		const second = getOrCreateSessionTreeStore(manager);
		expect(second).toBe(first);
	});

	it("does not unregister a replacement mapping", () => {
		const manager = {};
		const first = createSessionTreeStore();
		const second = createSessionTreeStore();
		registerSessionTreeStore(manager, first);
		registerSessionTreeStore(manager, second);
		unregisterSessionTreeStore(manager, first);
		expect(getSessionTreeStore(manager)).toBe(second);
	});

	it("resolves a tree store by session id", () => {
		const store = createSessionTreeStore();
		registerSessionIdTreeStore("session-1", store);
		expect(getSessionIdTreeStore("session-1")).toBe(store);
	});

	it("keeps session ids isolated from each other", () => {
		const first = createSessionTreeStore();
		const second = createSessionTreeStore();
		registerSessionIdTreeStore("session-1", first);
		registerSessionIdTreeStore("session-2", second);

		expect(getSessionIdTreeStore("session-1")).toBe(first);
		expect(getSessionIdTreeStore("session-2")).toBe(second);
	});

	it("removes a session id mapping on unregister", () => {
		const store = createSessionTreeStore();
		registerSessionIdTreeStore("session-1", store);
		unregisterSessionIdTreeStore("session-1", store);
		expect(getSessionIdTreeStore("session-1")).toBeUndefined();
	});

	it("does not unregister a replacement session id mapping", () => {
		const first = createSessionTreeStore();
		const second = createSessionTreeStore();
		registerSessionIdTreeStore("session-1", first);
		registerSessionIdTreeStore("session-1", second);
		unregisterSessionIdTreeStore("session-1", first);
		expect(getSessionIdTreeStore("session-1")).toBe(second);
	});
});
