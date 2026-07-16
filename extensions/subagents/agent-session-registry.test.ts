import { describe, expect, it, vi } from "vitest";
import type { AgentPath } from "./agent-path.js";
import {
	AgentSessionRegistry,
	type AgentNodeSnapshot,
	type AgentOperationalSnapshot,
	type CreateAgentNodeRequest,
} from "./agent-session-registry.js";
import type { ChildSessionConfig, ManagedChildSessionDependencies } from "./managed-child-session.js";

function usage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function operational(overrides: Partial<AgentOperationalSnapshot> = {}): AgentOperationalSnapshot {
	return {
		state: "running",
		usage: usage(),
		lastTurnInput: 0,
		hasSubgroup: false,
		pendingCorrelations: [],
		waitingFor: [],
		...overrides,
	};
}

function rootSnapshot(overrides: Partial<AgentNodeSnapshot> = {}): AgentNodeSnapshot & { path: []; ownership: "external" } {
	return {
		path: [],
		parentPath: null,
		localId: null,
		ownership: "external",
		sessionId: "root-session",
		sessionFile: "/sessions/root.jsonl",
		cwd: "/repo",
		channels: [],
		operational: operational({ state: "idle" }),
		...overrides,
		path: [],
		ownership: "external",
	};
}

function dependencies(): ManagedChildSessionDependencies {
	return {
		agentDir: "/agent",
		authStorage: {} as ManagedChildSessionDependencies["authStorage"],
		modelRegistry: {} as ManagedChildSessionDependencies["modelRegistry"],
	};
}

function fakeSession(sessionId: string): any {
	return {
		sessionId,
		sessionFile: `/sessions/${sessionId}.jsonl`,
		runtime: { dispose: vi.fn(async () => {}) },
		dispose: vi.fn(async () => {}),
		presentation: { attach: vi.fn(() => () => {}), reset: vi.fn() },
	};
}

function request(localId: string, overrides: Partial<CreateAgentNodeRequest> = {}): CreateAgentNodeRequest {
	const session: Omit<ChildSessionConfig, "path" | "scope"> & { uplink: any } = {
		target: { kind: "new", cwd: "/repo", sessionDir: "/sessions" },
		toolPolicy: { allowedTools: undefined, excludeTools: ["ask_user"] },
		skillPaths: [],
		appendSystemPrompt: [],
		uplink: { id: `${localId}-uplink` },
	};
	return {
		localId,
		task: `task-${localId}`,
		channels: [],
		session,
		initialOperational: operational(),
		...overrides,
	};
}

function createRegistry(
	createSession = vi.fn(async (config: any) => fakeSession(config.path.join("/"))),
): { registry: AgentSessionRegistry; createSession: typeof createSession } {
	return {
		registry: new AgentSessionRegistry({
			root: rootSnapshot(),
			dependencies: dependencies(),
			createSession,
		}),
		createSession,
	};
}

describe("AgentSessionRegistry root ownership and paths", () => {
	it("registers exactly one external root at [] and never owns its runtime", async () => {
		const { registry } = createRegistry();
		const root = registry.get([]);

		expect(root?.snapshot).toMatchObject({ path: [], parentPath: null, ownership: "external" });
		expect(registry.getSnapshot([])?.sessionId).toBe("root-session");
		await registry.dispose();
		// The registry may dispose descendants, but the external root remains host-owned.
		expect(registry.getSnapshot([])).toEqual(root?.snapshot);
	});

	it("derives canonical child paths and rejects duplicate live sibling ids", async () => {
		const { registry, createSession } = createRegistry();
		const events: any[] = [];
		registry.subscribe((event) => events.push(event));
		const [researcher] = await registry.createChildren([], [request("researcher")]);
		const [scout] = await registry.createChildren(["researcher"], [request("scout")]);

		expect(researcher.snapshot.path).toEqual(["researcher"]);
		expect(researcher.snapshot.parentPath).toEqual([]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "node_added", node: { path: ["researcher"] } });
		expect(createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				path: ["researcher"],
				scope: expect.objectContaining({ registry, path: ["researcher"], identity: expect.objectContaining({ id: "researcher" }) }),
			}),
			expect.anything(),
			expect.anything(),
		);
		expect(scout.snapshot.path).toEqual(["researcher", "scout"]);
		expect(scout.snapshot.parentPath).toEqual(["researcher"]);
		await expect(registry.createChildren([], [request("researcher")])).rejects.toThrow(/duplicate|exists|sibling/i);
		await expect(registry.createChildren([], [request("parent")])).rejects.toThrow(/parent|reserved/i);
	});

	it("allows the same local id under different live parents without path collision", async () => {
		const { registry } = createRegistry();
		await registry.createChildren([], [request("left"), request("right")]);
		const [leftWorker] = await registry.createChildren(["left"], [request("worker")]);
		const [rightWorker] = await registry.createChildren(["right"], [request("worker")]);

		expect(leftWorker.snapshot.path).toEqual(["left", "worker"]);
		expect(rightWorker.snapshot.path).toEqual(["right", "worker"]);
	});
});

describe("AgentSessionRegistry atomic creation and snapshots", () => {
	it("rolls back every staged session and event when one batch creation fails", async () => {
		const first = fakeSession("first");
		const createSession = vi.fn()
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error("second failed"));
		const { registry } = createRegistry(createSession as any);
		const events: unknown[] = [];
		registry.subscribe((event) => events.push(event));

		await expect(registry.createChildren([], [request("first"), request("second")])).rejects.toThrow("second failed");
		expect(first.dispose).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);
		expect(registry.getSnapshot(["first"])).toBeUndefined();
		expect(registry.getSnapshot(["second"])).toBeUndefined();
	});

	it("replaces immutable operational snapshots only when values change", async () => {
		const { registry } = createRegistry();
		await registry.createChildren([], [request("worker")]);
		const events: any[] = [];
		registry.subscribe((event) => events.push(event));
		const before = registry.getSnapshot(["worker"]);
		const next = operational({ state: "idle", lastOutput: "done" });

		registry.updateOperational(["worker"], next);
		const after = registry.getSnapshot(["worker"]);
		registry.updateOperational(["worker"], next);

		expect(after).not.toBe(before);
		expect(before?.operational.state).toBe("running");
		expect(after?.operational).toEqual(next);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "node_updated", previous: before, node: after });
	});

	it("updates session metadata in place without changing canonical path or parentage", async () => {
		const hooks: any[] = [];
		const createSession = vi.fn(async (config: any, _deps: any, childHooks: any) => {
			hooks.push(childHooks);
			return fakeSession(config.path.join("/"));
		});
		const { registry } = createRegistry(createSession as any);
		await registry.createChildren([], [request("worker")]);
		const events: any[] = [];
		registry.subscribe((event) => events.push(event));

		hooks[0].onSessionChanged({ sessionId: "replacement", sessionFile: "/sessions/replacement.jsonl", cwd: "/other" });
		const snapshot = registry.getSnapshot(["worker"]);

		expect(snapshot).toMatchObject({
			path: ["worker"],
			parentPath: [],
			sessionId: "replacement",
			sessionFile: "/sessions/replacement.jsonl",
			cwd: "/other",
		});
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("node_updated");
	});
});

describe("AgentSessionRegistry removal, attachment, and lifecycle", () => {
	it("removes descendants bottom-up, emits final snapshots, and allows live path reuse", async () => {
		const { registry } = createRegistry();
		const [parent] = await registry.createChildren([], [request("worker")]);
		const [grandchild] = await registry.createChildren(["worker"], [request("scout")]);
		const removed: string[][] = [];
		registry.subscribe((event) => {
			if (event.type === "node_removed") removed.push([...event.node.path]);
		});

		await registry.remove(["worker"]);
		await registry.remove(["worker"]);
		expect(removed).toEqual([["worker", "scout"], ["worker"]]);
		expect((grandchild.session as any).dispose).toHaveBeenCalledTimes(1);
		expect((parent.session as any).dispose).toHaveBeenCalledTimes(1);
		expect(registry.getSnapshot(["worker"])).toBeUndefined();

		const [reused] = await registry.createChildren([], [request("worker")]);
		expect(reused.snapshot.path).toEqual(["worker"]);
	});

	it("attaches presentation only to registry-owned descendants and detaches by token", async () => {
		const { registry } = createRegistry();
		const [child] = await registry.createChildren([], [request("worker")]);
		const target: any = { notify: vi.fn() };

		const detach = registry.attachPresentation(["worker"], target);
		expect((child.presentation as any).attach).toHaveBeenCalledWith(target);
		detach();
		expect(() => registry.attachPresentation([], target)).toThrow(/root|presentation|external/i);
	});

	it("survives subscriber failures while completing registry lifecycle operations", async () => {
		const { registry } = createRegistry();
		registry.subscribe(() => {
			throw new Error("observer failed");
		});

		await expect(registry.createChildren([], [request("worker")])).resolves.toHaveLength(1);
		await expect(registry.remove(["worker"])).resolves.toBeUndefined();
	});
});
