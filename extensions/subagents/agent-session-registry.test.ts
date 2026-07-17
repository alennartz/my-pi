import { describe, expect, it, vi } from "vitest";
import type { AgentPath } from "./agent-path.js";
import {
	AgentSessionRegistry,
	type AgentNodeSnapshot,
	type AgentOperationalSnapshot,
	type CreateAgentNodeRequest,
} from "./agent-session-registry.js";
import type {
	ChildSessionConfig,
	ChildSessionHooks,
	ManagedChildSessionDependencies,
} from "./managed-child-session.js";

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
	return { agentDir: "/agent" };
}

function makeHooks(): ChildSessionHooks {
	return {
		onEvent: vi.fn(),
		onUiNotify: vi.fn(),
		onSessionChanged: vi.fn(),
		onShutdownRequested: vi.fn(),
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
		hooks: makeHooks(),
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
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ type: "node_added", node: { path: ["researcher"] } });
		expect(events[1]).toMatchObject({ type: "node_added", node: { path: ["researcher", "scout"] } });
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
		expect(registry.listChildren([]).map((node) => node.path)).toEqual([["researcher"]]);
		expect(registry.listChildren(["researcher"]).map((node) => node.path)).toEqual([["researcher", "scout"]]);
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
		const retried = fakeSession("first-retry");
		const createSession = vi.fn()
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error("second failed"))
			.mockResolvedValueOnce(retried);
		const { registry } = createRegistry(createSession as any);
		const events: unknown[] = [];
		registry.subscribe((event) => events.push(event));

		await expect(registry.createChildren([], [request("first"), request("second")])).rejects.toThrow("second failed");
		expect(first.dispose).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);
		expect(registry.getSnapshot(["first"])).toBeUndefined();
		expect(registry.getSnapshot(["second"])).toBeUndefined();

		const [reused] = await registry.createChildren([], [request("first")]);
		expect(reused.session).toBe(retried);
	});

	it("rejects duplicate batch IDs and unknown parents before creating sessions", async () => {
		const { registry, createSession } = createRegistry();

		await expect(registry.createChildren([], [request("duplicate"), request("duplicate")])).rejects.toThrow(/duplicate|exists|sibling/i);
		await expect(registry.createChildren(["missing"], [request("worker")])).rejects.toThrow(/parent|missing|unknown/i);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("reserves paths while an overlapping creation is still pending", async () => {
		let resolveFirst!: (session: any) => void;
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const createSession = vi.fn(() => new Promise<any>((resolve) => {
			resolveFirst = resolve;
			signalStarted();
		}));
		const { registry } = createRegistry(createSession as any);

		const first = registry.createChildren([], [request("worker")]);
		await started;
		await expect(registry.createChildren([], [request("worker")])).rejects.toThrow(/duplicate|exists|reserved/i);
		resolveFirst(fakeSession("worker"));
		await expect(first).resolves.toHaveLength(1);
	});

	it("replaces immutable operational snapshots only when values change", async () => {
		const { registry } = createRegistry();
		await registry.createChildren([], [request("worker")]);
		const events: any[] = [];
		registry.subscribe((event) => events.push(event));
		const before = registry.getSnapshot(["worker"])!;
		const equalByValue = operational();
		const next = operational({ state: "idle", lastOutput: "done" });

		registry.updateOperational(["worker"], equalByValue);
		expect(events).toEqual([]);
		registry.updateOperational(["worker"], next);
		const after = registry.getSnapshot(["worker"])!;
		registry.updateOperational(["worker"], operational({ state: "idle", lastOutput: "done" }));

		expect(after).not.toBe(before);
		expect(before.operational.state).toBe("running");
		expect(after.operational).toEqual(next);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "node_updated", previous: before, node: after });

		try {
			(next.pendingCorrelations as string[]).push("input-mutation");
		} catch {
			// A frozen input is also safe; it must not leak into registry state.
		}
		try {
			(next.usage as { input: number }).input = 99;
		} catch {
			// A frozen input is also safe; it must not leak into registry state.
		}
		try {
			(after.operational.waitingFor as string[]).push("snapshot-mutation");
		} catch {
			// A frozen returned snapshot is also safe.
		}
		const current = registry.getSnapshot(["worker"])!;
		expect(current.operational.pendingCorrelations).toEqual([]);
		expect(current.operational.waitingFor).toEqual([]);
		expect(current.operational.usage.input).toBe(0);
	});

	it("updates session metadata before forwarding onSessionChanged while forwarding other hooks", async () => {
		const decoratedHooks: any[] = [];
		const managerHooks = makeHooks();
		const createSession = vi.fn(async (config: any, _deps: any, childHooks: any) => {
			decoratedHooks.push(childHooks);
			return fakeSession(config.path.join("/"));
		});
		const { registry } = createRegistry(createSession as any);
		const replacement = { sessionId: "replacement", sessionFile: "/sessions/replacement.jsonl", cwd: "/other" };
		managerHooks.onSessionChanged = vi.fn(() => {
			expect(registry.getSnapshot(["worker"])).toMatchObject({
				sessionId: replacement.sessionId,
				sessionFile: replacement.sessionFile,
				cwd: replacement.cwd,
			});
		});
		await registry.createChildren([], [request("worker", { hooks: managerHooks })]);
		const events: any[] = [];
		registry.subscribe((event) => events.push(event));

		const event = { type: "agent_start" } as any;
		decoratedHooks[0].onEvent(event);
		decoratedHooks[0].onUiNotify("child warning", "warning");
		decoratedHooks[0].onShutdownRequested();
		decoratedHooks[0].onSessionChanged(replacement);

		expect(managerHooks.onEvent).toHaveBeenCalledWith(event);
		expect(managerHooks.onUiNotify).toHaveBeenCalledWith("child warning", "warning");
		expect(managerHooks.onShutdownRequested).toHaveBeenCalledTimes(1);
		expect(managerHooks.onSessionChanged).toHaveBeenCalledWith(replacement);
		expect(registry.getSnapshot(["worker"])).toMatchObject({
			path: ["worker"],
			parentPath: [],
			sessionId: "replacement",
			sessionFile: "/sessions/replacement.jsonl",
			cwd: "/other",
		});
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("node_updated");
	});

	it("decorates each request's hooks independently in a creation batch", async () => {
		const hooksByPath = new Map<string, ChildSessionHooks>();
		const firstHooks = makeHooks();
		const secondHooks = makeHooks();
		const createSession = vi.fn(async (config: any, _deps: any, hooks: ChildSessionHooks) => {
			hooksByPath.set(JSON.stringify(config.path), hooks);
			return fakeSession(config.path.join("/"));
		});
		const { registry } = createRegistry(createSession as any);
		await registry.createChildren([], [
			request("first", { hooks: firstHooks }),
			request("second", { hooks: secondHooks }),
		]);

		const firstMetadata = { sessionId: "first-replacement", cwd: "/first" };
		const secondMetadata = { sessionId: "second-replacement", cwd: "/second" };
		hooksByPath.get('["first"]')!.onSessionChanged(firstMetadata);
		hooksByPath.get('["second"]')!.onSessionChanged(secondMetadata);

		expect(firstHooks.onSessionChanged).toHaveBeenCalledWith(firstMetadata);
		expect(secondHooks.onSessionChanged).toHaveBeenCalledWith(secondMetadata);
		expect(firstHooks.onSessionChanged).not.toHaveBeenCalledWith(secondMetadata);
		expect(secondHooks.onSessionChanged).not.toHaveBeenCalledWith(firstMetadata);
		expect(registry.getSnapshot(["first"])).toMatchObject(firstMetadata);
		expect(registry.getSnapshot(["second"])).toMatchObject(secondMetadata);
	});
});

describe("AgentSessionRegistry removal, attachment, and lifecycle", () => {
	it("removes descendants bottom-up, emits final snapshots, and allows live path reuse", async () => {
		const { registry } = createRegistry();
		const [parent] = await registry.createChildren([], [request("worker")]);
		const [grandchild] = await registry.createChildren(["worker"], [request("scout")]);
		registry.updateOperational(["worker"], operational({ state: "failed", lastError: "final failure" }));
		const removed: Array<{ path: string[]; lastError?: string }> = [];
		registry.subscribe((event) => {
			if (event.type === "node_removed") {
				removed.push({ path: [...event.node.path], lastError: event.node.operational.lastError });
			}
		});

		await registry.remove(["worker"]);
		await registry.remove(["worker"]);
		expect(removed).toEqual([
			{ path: ["worker", "scout"], lastError: undefined },
			{ path: ["worker"], lastError: "final failure" },
		]);
		expect((grandchild.session as any).dispose).toHaveBeenCalledTimes(1);
		expect((parent.session as any).dispose).toHaveBeenCalledTimes(1);
		expect(registry.getSnapshot(["worker"])).toBeUndefined();
		await expect(registry.remove([])).rejects.toThrow(/root|external|invalid/i);

		const [reused] = await registry.createChildren([], [request("worker")]);
		expect(reused.snapshot.path).toEqual(["worker"]);
	});

	it("attaches presentation only to registry-owned descendants and returns the delegate detach token", async () => {
		const { registry } = createRegistry();
		const [child] = await registry.createChildren([], [request("worker")]);
		const target: any = { notify: vi.fn() };
		const delegateDetach = vi.fn();
		(child.presentation as any).attach.mockReturnValueOnce(delegateDetach);

		const detach = registry.attachPresentation(["worker"], target);
		expect((child.presentation as any).attach).toHaveBeenCalledWith(target);
		detach();
		expect(delegateDetach).toHaveBeenCalledTimes(1);
		expect(() => registry.attachPresentation([], target)).toThrow(/root|presentation|external/i);
	});

	it("disposes live descendants bottom-up while leaving the external root host-owned", async () => {
		const { registry } = createRegistry();
		const [parent] = await registry.createChildren([], [request("worker")]);
		const [child] = await registry.createChildren(["worker"], [request("scout")]);
		const removed: string[][] = [];
		registry.subscribe((event) => {
			if (event.type === "node_removed") removed.push([...event.node.path]);
		});

		await registry.dispose();
		await registry.dispose();
		expect((child.session as any).dispose).toHaveBeenCalledTimes(1);
		expect((parent.session as any).dispose).toHaveBeenCalledTimes(1);
		expect(removed).toEqual([["worker", "scout"], ["worker"]]);
		expect(registry.getSnapshot([])?.ownership).toBe("external");
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
