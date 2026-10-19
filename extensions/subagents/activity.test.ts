import { describe, expect, it, vi } from "vitest";
import { askActivity } from "@pimote/sdk/activity";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { createSubagentsExtension } from "./scoped-extension.js";
import { hasLiveBackgroundWork, type ActivityNode } from "./activity.js";
import type { AgentPath } from "./agent-path.js";
import type { MessagePort } from "./message-router.js";

// Helpers

function createMockEventBus(): EventBus & { handlers: Map<string, Set<(data: unknown) => void>> } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		handlers,
		emit(channel: string, data: unknown): void {
			const set = handlers.get(channel);
			if (set) for (const handler of set) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void): () => void {
			let set = handlers.get(channel);
			if (!set) {
				set = new Set();
				handlers.set(channel, set);
			}
			set.add(handler);
			return () => {
				set!.delete(handler);
			};
		},
	};
}

function makePi(eventBus: EventBus): { registerTool: ReturnType<typeof vi.fn>; events: EventBus } {
	return { registerTool: vi.fn(), events: eventBus };
}

function node(path: string[], state: ActivityNode["operational"]["state"], waitingFor: string[] = []): ActivityNode {
	return { path, operational: { state, waitingFor } };
}

// Predicate

describe("hasLiveBackgroundWork", () => {
	it("empty tree is not live", () => {
		expect(hasLiveBackgroundWork([])).toBe(false);
	});

	it("running anywhere is live, at any depth", () => {
		expect(hasLiveBackgroundWork([node(["worker"], "idle"), node(["worker", "scout"], "running")])).toBe(true);
	});

	it("settled and terminal states are never live", () => {
		expect(hasLiveBackgroundWork([node(["a"], "idle"), node(["b"], "errored"), node(["c"], "dead")])).toBe(false);
	});

	it("immediate child waiting only on parent is parked on the root session", () => {
		expect(hasLiveBackgroundWork([node(["worker"], "waiting", ["parent"])])).toBe(false);
	});

	it("immediate child waiting on a sibling is live", () => {
		expect(hasLiveBackgroundWork([node(["worker"], "waiting", ["scout"])])).toBe(true);
		expect(hasLiveBackgroundWork([node(["worker"], "waiting", ["parent", "scout"])])).toBe(true);
	});

	it("deep agent waiting on its parent is live — the parent is in-tree", () => {
		expect(hasLiveBackgroundWork([node(["worker", "scout"], "waiting", ["parent"])])).toBe(true);
	});
});

// Wiring

describe("subagents activity responder", () => {
	it("root scope registers and answers the poll (false before session_start)", async () => {
		const eventBus = createMockEventBus();
		await createSubagentsExtension({ kind: "root" })(makePi(eventBus) as any);

		expect(eventBus.handlers.get("pimote:activity:request")?.size).toBe(1);
		// before-start phase fails open: no bundle, no agents, nothing to protect.
		expect(askActivity(eventBus)).toBe(false);
	});

	it("child scope never registers a responder", async () => {
		const eventBus = createMockEventBus();
		const scope = {
			kind: "child",
			registry: {},
			path: ["worker"] as AgentPath,
			identity: { id: "worker", task: "work", channels: ["parent"] },
			uplink: {} as MessagePort,
		};
		await createSubagentsExtension(scope)(makePi(eventBus) as any);

		expect(eventBus.handlers.get("pimote:activity:request")?.size ?? 0).toBe(0);
		expect(askActivity(eventBus)).toBe(false);
	});
});
