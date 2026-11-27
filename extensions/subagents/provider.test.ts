import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SubagentLeaseEvent, SubagentPresenters, SubagentTopologyEvent } from "@pimote/sdk/subagents";
import type { AgentNodeSnapshot, AgentOperationalSnapshot, AgentRegistryNode, AgentSessionRegistry, RegistryEvent, RegisteredAgentNode } from "./agent-session-registry.js";
import type { AgentPath } from "./agent-path.js";
import type { ManagedChildSession } from "./managed-child-session.js";
import { createSubagentProvider } from "./provider.js";

const operational: AgentOperationalSnapshot = {
	state: "idle",
	usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
	lastTurnInput: 200,
	contextWindow: 800,
	hasSubgroup: false,
	pendingCorrelations: [],
	waitingFor: [],
};

function child(path: AgentPath, sessionId: string, incarnation: string, patch: Partial<AgentOperationalSnapshot> = {}): RegisteredAgentNode {
	const snapshot: AgentNodeSnapshot = {
		path,
		parentPath: path.slice(0, -1),
		localId: path.at(-1) ?? null,
		ownership: "registry",
		incarnation,
		sessionId,
		cwd: "/work",
		task: `task of ${path.join("/")}`,
		channels: ["parent"],
		operational: { ...operational, ...patch },
	};
	const native = { sessionId, dispose: vi.fn(async () => undefined) } as unknown as AgentSession;
	return { snapshot, session: { session: native, capabilities: { operations: ["prompt"] } } as unknown as ManagedChildSession } as RegisteredAgentNode;
}

function fixture() {
	const nodes: AgentRegistryNode[] = [child(["worker"], "s-worker", "i-worker"), child(["worker", "scout"], "s-scout", "i-scout")];
	const listeners = new Set<(event: RegistryEvent) => void>();
	const find = (path: AgentPath) => nodes.find((item) => JSON.stringify(item.snapshot.path) === JSON.stringify(path));
	const registry = {
		get: find,
		getSnapshot: (path: AgentPath) => path.length === 0 ? { cwd: "/root" } : find(path)?.snapshot,
		listChildren: (parent: AgentPath) => nodes.flatMap((item) => JSON.stringify(item.snapshot.parentPath) === JSON.stringify(parent) ? [item.snapshot] : []),
		listDescendants: () => nodes.map((item) => item.snapshot),
		subscribe: (listener: (event: RegistryEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as AgentSessionRegistry;
	const emit = (event: RegistryEvent) => {
		for (const listener of listeners) {listener(event);}
	};
	const control = {
		teardown: vi.fn(async (ref: { path: AgentPath; incarnation: string }) => ({ path: ref.path, removed: true })),
		stop: vi.fn(async () => undefined),
		setHold: vi.fn(async () => undefined),
		resurrect: vi.fn(async (request: { parentPath: AgentPath; localId: string }) => ({ path: [...request.parentPath, request.localId] })),
	};
	const provider = createSubagentProvider({ registry, control, presenters: {} as SubagentPresenters });
	const events: SubagentTopologyEvent[] = [];
	provider.subscribe((event) => events.push(event));
	return {
		provider,
		control,
		events,
		update(path: AgentPath, patch: Partial<AgentOperationalSnapshot>) {
			const index = nodes.findIndex((item) => JSON.stringify(item.snapshot.path) === JSON.stringify(path));
			const previous = nodes[index].snapshot;
			nodes[index] = child(path, previous.sessionId, previous.incarnation, { ...previous.operational, ...patch });
			emit({ type: "node_updated", previous, node: nodes[index].snapshot });
		},
		replaceRuntime(path: AgentPath, sessionId: string) {
			const index = nodes.findIndex((item) => JSON.stringify(item.snapshot.path) === JSON.stringify(path));
			const previous = nodes[index].snapshot;
			nodes[index] = child(path, sessionId, previous.incarnation, previous.operational);
			emit({ type: "runtime_replaced", previous, node: nodes[index].snapshot, oldSessionId: previous.sessionId, newSessionId: sessionId });
		},
		remove(path: AgentPath) {
			for (const item of nodes.filter((candidate) => path.every((part, index) => candidate.snapshot.path[index] === part)).toReversed()) {
				nodes.splice(nodes.indexOf(item), 1);
				emit({ type: "node_removed", node: item.snapshot });
			}
		},
	};
}

describe("subagent provider topology", () => {
	it("snapshots every live child with identity, usage, context fill, and hold state, not ready before restore", () => {
		const { provider } = fixture();
		const snapshot = provider.snapshot();
		expect(snapshot.ready).toBe(false);
		expect(snapshot.rootCwd).toBe("/root");
		expect(snapshot.nodes.map((node) => [node.path, node.incarnation, node.sessionId, node.contextFill, node.held])).toEqual([
			[["worker"], "i-worker", "s-worker", 25, false],
			[["worker", "scout"], "i-scout", "s-scout", 25, false],
		]);
		expect(snapshot.nodes[0].hasSubgroup).toBe(true);
	});

	it("turns ready once the root and every tracked restore finished", async () => {
		const { provider, events } = fixture();
		let finish!: () => void;
		provider.trackRestore(new Promise<void>((resolve) => { finish = resolve; }));
		provider.markRootRestored();
		expect(provider.snapshot().ready).toBe(false);
		finish();
		await vi.waitFor(() => expect(provider.snapshot().ready).toBe(true));
		expect(events.at(-1)).toMatchObject({ kind: "ready" });
	});

	it("numbers events after the snapshot and reports hold changes as node updates", () => {
		const { provider, events, update } = fixture();
		const base = provider.snapshot().sequence;
		update(["worker"], { held: true, heldSettlement: "idle" });
		update(["worker"], { held: true, heldSettlement: "idle" });
		expect(events).toEqual([expect.objectContaining({ sequence: base + 1, kind: "node_updated" })]);
		expect(provider.snapshot().nodes[0]).toMatchObject({ held: true, heldSettlement: "idle" });
	});

	it("reports a runtime replacement and keeps the incarnation", () => {
		const { provider, events, replaceRuntime } = fixture();
		replaceRuntime(["worker"], "s-worker-2");
		expect(events).toEqual([expect.objectContaining({ kind: "runtime_replaced", path: ["worker"], incarnation: "i-worker", oldSessionId: "s-worker", newSessionId: "s-worker-2" })]);
		expect(provider.snapshot().nodes[0]).toMatchObject({ sessionId: "s-worker-2", incarnation: "i-worker" });
	});
});

describe("subagent provider leases", () => {
	it("borrows the native child session and never touches orchestration", async () => {
		const { provider, control } = fixture();
		const lease = await provider.acquire({ path: ["worker"], incarnation: "i-worker" });
		expect(lease.session.sessionId).toBe("s-worker");
		expect(lease.capabilities.operations).toEqual(["prompt"]);
		lease.release();
		lease.release();
		expect(() => lease.session).toThrow();
		expect(Object.values(control).every((fn) => fn.mock.calls.length === 0)).toBe(true);
	});

	it("rejects an unknown path or a stale incarnation", async () => {
		const { provider } = fixture();
		await expect(provider.acquire({ path: ["nobody"], incarnation: "x" })).rejects.toThrow();
		await expect(provider.acquire({ path: ["worker"], incarnation: "old" })).rejects.toThrow(/stale/i);
	});

	it("rebinds leases to a replacement runtime and closes a removed subtree's leases", async () => {
		const { provider, replaceRuntime, remove } = fixture();
		const worker = await provider.acquire({ path: ["worker"], incarnation: "i-worker" });
		const scout = await provider.acquire({ path: ["worker", "scout"], incarnation: "i-scout" });
		const workerEvents: SubagentLeaseEvent[] = [];
		const scoutEvents: SubagentLeaseEvent[] = [];
		worker.subscribe((event) => workerEvents.push(event));
		scout.subscribe((event) => scoutEvents.push(event));
		replaceRuntime(["worker"], "s-worker-2");
		expect(workerEvents[0]).toMatchObject({ kind: "rebound" });
		expect(worker.session.sessionId).toBe("s-worker-2");
		remove(["worker"]);
		expect(workerEvents.at(-1)).toEqual({ kind: "closed", reason: "removed" });
		expect(scoutEvents).toEqual([{ kind: "closed", reason: "removed" }]);
	});

	it("closes leases as unavailable on shutdown and stops publishing", async () => {
		const { provider, events, update } = fixture();
		const lease = await provider.acquire({ path: ["worker"], incarnation: "i-worker" });
		const seen: SubagentLeaseEvent[] = [];
		lease.subscribe((event) => seen.push(event));
		provider.shutdown();
		expect(seen).toEqual([{ kind: "closed", reason: "unavailable" }]);
		update(["worker"], { state: "running" });
		expect(events).toEqual([]);
		await expect(provider.acquire({ path: ["worker"], incarnation: "i-worker" })).rejects.toThrow();
	});
});

describe("subagent provider controls", () => {
	it("forwards the full path and incarnation of each guarded control", async () => {
		const { provider, control } = fixture();
		await provider.teardown({ path: ["worker", "scout"], incarnation: "i-scout" });
		await provider.setHold({ path: ["worker"], incarnation: "i-worker", held: true });
		await provider.stop({ path: ["worker"], incarnation: "i-worker", expectedSessionId: "s-worker" });
		expect(control.teardown).toHaveBeenCalledWith({ path: ["worker", "scout"], incarnation: "i-scout" });
		expect(control.setHold).toHaveBeenCalledWith({ path: ["worker"], incarnation: "i-worker", held: true });
		expect(control.stop).toHaveBeenCalledWith({ path: ["worker"], incarnation: "i-worker", expectedSessionId: "s-worker" });
	});

	it("rejects controls for a stale incarnation or another runtime", async () => {
		const { provider, control } = fixture();
		await expect(provider.teardown({ path: ["worker"], incarnation: "old" })).rejects.toThrow();
		await expect(provider.stop({ path: ["worker"], incarnation: "i-worker", expectedSessionId: "s-other" })).rejects.toThrow();
		await expect(provider.setHold({ path: ["gone"], incarnation: "x", held: true })).rejects.toThrow();
		expect(control.teardown).not.toHaveBeenCalled();
		expect(control.stop).not.toHaveBeenCalled();
		expect(control.setHold).not.toHaveBeenCalled();
	});
});
