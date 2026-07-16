import { describe, expect, it, vi } from "vitest";
import { SubagentManager, type AgentStatus } from "./agent-set.js";
import type {
	AgentNodeSnapshot,
	AgentOperationalSnapshot,
	AgentRegistryNode,
	AgentSessionRegistry,
} from "./agent-session-registry.js";
import type { AgentPath } from "./agent-path.js";

function usage(overrides: Partial<AgentOperationalSnapshot["usage"]> = {}) {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...overrides };
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

function snapshot(
	localId: string,
	path: AgentPath = ["researcher", localId],
	overrides: Partial<AgentNodeSnapshot> = {},
): AgentNodeSnapshot {
	return {
		path,
		parentPath: path.slice(0, -1),
		localId,
		ownership: "registry",
		sessionId: `${localId}-session`,
		sessionFile: `/sessions/${localId}.jsonl`,
		cwd: "/repo",
		task: `task-${localId}`,
		channels: ["parent"],
		operational: operational(),
		...overrides,
	};
}

function makeRegistry(initial: AgentNodeSnapshot[] = []): any {
	const snapshots = [...initial];
	const nodes = new Map<string, any>();
	for (const entry of snapshots) {
		nodes.set(JSON.stringify(entry.path), {
			snapshot: entry,
			session: { abort: vi.fn(async () => {}) },
		});
	}
	return {
		listChildren: vi.fn(() => snapshots),
		get: vi.fn((path: AgentPath) => nodes.get(JSON.stringify(path))),
		getSnapshot: vi.fn((path: AgentPath) => snapshots.find((entry) => JSON.stringify(entry.path) === JSON.stringify(path))),
		updateOperational: vi.fn(),
		createChildren: vi.fn(),
		remove: vi.fn(),
		snapshots,
		nodes,
	};
}

function createManager(registry: AgentSessionRegistry, ownerPath: AgentPath = ["researcher"]) {
	const onUpdate = vi.fn();
	const onAgentComplete = vi.fn();
	const onParentMessage = vi.fn();
	const manager = new SubagentManager({
		pi: {} as any,
		cwd: "/tmp",
		registry,
		ownerPath,
		skillPaths: new Map(),
		resolveContextWindow: () => undefined,
		onUpdate,
		onAgentComplete,
		onParentMessage,
	});
	return { manager, onUpdate, onAgentComplete, onParentMessage };
}

describe("registry-backed manager status projection", () => {
	it("reads immediate-child statuses from the canonical registry path", () => {
		const worker = snapshot("worker", ["researcher", "worker"], {
			operational: operational({
				state: "waiting",
				usage: usage({ input: 12, output: 4, cost: 0.03, turns: 2 }),
				lastOutput: "still working",
				waitingFor: ["peer"],
			}),
		});
		const registry = makeRegistry([worker]);
		const { manager } = createManager(registry, ["researcher"]);

		const statuses = manager.getAgentStatuses();
		expect(registry.listChildren).toHaveBeenCalledWith(["researcher"]);
		expect(statuses).toEqual([expect.objectContaining<Partial<AgentStatus>>({
			id: "worker",
			state: "waiting",
			task: "task-worker",
			usage: worker.operational.usage,
			lastOutput: "still working",
			waitingFor: ["peer"],
		})]);
	});

	it("reflects canonical snapshot replacement instead of retaining a manager-local status copy", () => {
		const running = snapshot("worker");
		const idle = snapshot("worker", ["researcher", "worker"], {
			operational: operational({ state: "idle", lastOutput: "done" }),
		});
		const registry = makeRegistry([running]);
		registry.listChildren
			.mockReturnValueOnce([running])
			.mockReturnValueOnce([idle]);
		const { manager } = createManager(registry);

		expect(manager.getAgentStatus("worker")?.state).toBe("running");
		expect(manager.getAgentStatus("worker")?.lastOutput).toBeUndefined();
		expect(manager.getAgentStatus("worker")?.state).toBe("idle");
		expect(manager.getAgentStatus("worker")?.lastOutput).toBe("done");
	});

	it("reports no active children when the canonical registry has none", () => {
		const registry = makeRegistry([]);
		const { manager } = createManager(registry);

		expect(manager.hasAgents()).toBe(false);
		expect(manager.getAgentStatuses()).toEqual([]);
		expect(registry.listChildren).toHaveBeenCalledWith(["researcher"]);
	});
});

describe("registry-backed manager interruption", () => {
	it("resolves a child node through the registry and aborts its managed session", async () => {
		const worker = snapshot("worker");
		const registry = makeRegistry([worker]);
		const node = registry.get(["researcher", "worker"]);
		const { manager } = createManager(registry);

		await manager.interrupt("worker");
		expect(node.session.abort).toHaveBeenCalledTimes(1);
	});

	it("uses the owner path when resolving a duplicate local id under another branch", async () => {
		const worker = snapshot("worker", ["other", "worker"]);
		const registry = makeRegistry([worker]);
		const { manager } = createManager(registry, ["other"]);

		await manager.interrupt("worker");
		expect(registry.get).toHaveBeenCalledWith(["other", "worker"]);
	});
});
