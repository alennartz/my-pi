import { describe, expect, it } from "vitest";
import {
	createSessionTreeStore,
	getOrCreateSessionTreeStore,
	getSessionTreeStore,
	registerSessionTreeStore,
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
});
