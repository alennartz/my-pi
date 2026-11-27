import type {
	AgentPath,
	BorrowedAgentSession,
	SubagentCapabilities,
	SubagentHoldRequest,
	SubagentLease,
	SubagentLeaseEvent,
	SubagentNodeSnapshot,
	SubagentPresentationProvider,
	SubagentPresenters,
	SubagentResurrectRequest,
	SubagentResurrectResult,
	SubagentRuntimeRef,
	SubagentStopRequest,
	SubagentTeardownResult,
	SubagentTopologyEvent,
	SubagentTopologySnapshot,
	SubagentUsage,
} from "@pimote/sdk/subagents";
import type { AgentNodeSnapshot, AgentSessionRegistry, RegistryEvent } from "./agent-session-registry.js";
import { isRegisteredAgentNode } from "./agent-session-registry.js";
import type { SubagentControlPort } from "./control-port.js";

export interface SubagentProviderOptions {
	registry: AgentSessionRegistry;
	control: Pick<SubagentControlPort, "teardown" | "stop" | "setHold" | "resurrect">;
	presenters: SubagentPresenters;
}

/** The root provider plus the owner-side lifecycle calls it does not expose. */
export type OwnedSubagentProvider = SubagentPresentationProvider & {
	/** Report a restore that must end before the provider is ready. */
	trackRestore(restore: Promise<unknown>): void;
	/** The root restore ended. The provider turns ready once tracked restores end too. */
	markRootRestored(): void;
	/** Close every lease and stop publishing. */
	shutdown(): void;
};

type LeaseRecord = {
	readonly ref: SubagentRuntimeRef;
	session: BorrowedAgentSession | undefined;
	capabilities: SubagentCapabilities;
	readonly listeners: Set<(event: SubagentLeaseEvent) => void>;
};

/**
 * Topology, guarded controls, and presenters for one root session. Leases
 * borrow child runtimes for views. They never change what the parent agent
 * receives; only the explicit hold does.
 */
export function createSubagentProvider(options: SubagentProviderOptions): OwnedSubagentProvider {
	const { registry, control, presenters } = options;
	const nodes = new Map<string, SubagentNodeSnapshot>();
	const listeners = new Set<(event: SubagentTopologyEvent) => void>();
	const leases = new Set<LeaseRecord>();
	let sequence = 0;
	let closed = false;
	let rootRestored = false;
	let pendingRestores = 0;
	let ready = false;

	for (const snapshot of registry.listDescendants([])) {
		if (snapshot.ownership === "registry") {nodes.set(pathKey(snapshot.path), project(snapshot));}
	}
	const unsubscribe = registry.subscribe(onRegistryEvent);

	function project(snapshot: AgentNodeSnapshot): SubagentNodeSnapshot {
		const operational = snapshot.operational;
		const fill = contextFill(operational.lastTurnInput, operational.contextWindow);
		return Object.freeze({
			path: [...snapshot.path],
			incarnation: snapshot.incarnation,
			sessionId: snapshot.sessionId,
			...(snapshot.cwd ? { cwd: snapshot.cwd } : undefined),
			...(snapshot.task !== undefined ? { task: snapshot.task } : undefined),
			...(snapshot.persona !== undefined ? { persona: snapshot.persona } : undefined),
			...(snapshot.personaIcon !== undefined ? { personaIcon: snapshot.personaIcon } : undefined),
			...(operational.model !== undefined ? { model: operational.model } : undefined),
			...(operational.thinkingLevel !== undefined ? { thinkingLevel: operational.thinkingLevel } : undefined),
			state: operational.state,
			...(operational.lastActivity ? { activity: operational.lastActivity } : undefined),
			usage: usageOf(operational.usage),
			...(fill !== undefined ? { contextFill: fill } : undefined),
			channels: [...snapshot.channels],
			waitingFor: (operational.waitingForPaths ?? []).map((path) => [...path]),
			hasSubgroup: operational.hasSubgroup || registry.listChildren(snapshot.path).length > 0,
			...(operational.lastError ? { lastError: operational.lastError } : undefined),
			held: operational.held === true,
			...(operational.heldSettlement !== undefined ? { heldSettlement: operational.heldSettlement } : undefined),
		});
	}

	function publish(event: SubagentTopologyEvent): void {
		for (const listener of Array.from(listeners)) {
			try {
				listener(event);
			} catch (error) {
				console.error("[subagents] Topology listener failed:", error);
			}
		}
	}

	function setNode(snapshot: AgentNodeSnapshot): void {
		const key = pathKey(snapshot.path);
		const previous = nodes.get(key);
		const node = project(snapshot);
		if (previous && JSON.stringify(previous) === JSON.stringify(node)) {return;}
		nodes.set(key, node);
		if (previous && previous.incarnation !== node.incarnation) {closeLeases(previous.path, "removed");}
		const kind = previous && previous.incarnation === node.incarnation ? "node_updated" : "node_added";
		publish({ sequence: ++sequence, kind, node });
	}

	function refreshParent(path: AgentPath): void {
		if (path.length < 2) {return;}
		const parent = registry.getSnapshot(path.slice(0, -1));
		if (parent && parent.ownership === "registry") {setNode(parent);}
	}

	function onRegistryEvent(event: RegistryEvent): void {
		if (closed || event.node.path.length === 0 || event.node.ownership !== "registry") {return;}
		if (event.type === "node_removed") {
			const key = pathKey(event.node.path);
			const node = nodes.get(key) ?? project(event.node);
			nodes.delete(key);
			closeLeases(event.node.path, "removed");
			publish({ sequence: ++sequence, kind: "node_removed", node, reason: "removed" });
			refreshParent(event.node.path);
			return;
		}
		if (event.type === "runtime_replaced") {
			nodes.set(pathKey(event.node.path), project(event.node));
			publish({
				sequence: ++sequence,
				kind: "runtime_replaced",
				path: [...event.node.path],
				incarnation: event.node.incarnation,
				oldSessionId: event.oldSessionId,
				newSessionId: event.newSessionId,
			});
			rebindLeases(event.node.path);
			return;
		}
		setNode(event.node);
		if (event.type === "node_added") {refreshParent(event.node.path);}
	}

	function matchingNode(ref: SubagentRuntimeRef): SubagentNodeSnapshot {
		if (closed) {throw new Error("Subagent provider is shut down");}
		const node = nodes.get(pathKey(ref.path));
		if (!node) {throw new Error(`Unknown subagent path ${JSON.stringify(ref.path)}`);}
		if (node.incarnation !== ref.incarnation) {throw new Error(`Stale subagent incarnation for ${JSON.stringify(ref.path)}`);}
		return node;
	}

	type Borrowed = Readonly<{ session: BorrowedAgentSession; capabilities: SubagentCapabilities }>;

	function borrow(ref: SubagentRuntimeRef): Borrowed {
		const node = registry.get(ref.path);
		if (!node || !isRegisteredAgentNode(node) || node.snapshot.incarnation !== ref.incarnation) {
			throw new Error(`Subagent runtime is unavailable for ${JSON.stringify(ref.path)}`);
		}
		return { session: node.session.session, capabilities: node.session.capabilities ?? {} };
	}

	function notifyLease(record: LeaseRecord, event: SubagentLeaseEvent): void {
		for (const listener of Array.from(record.listeners)) {
			try {
				listener(event);
			} catch (error) {
				console.error("[subagents] Lease listener failed:", error);
			}
		}
	}

	function closeLease(record: LeaseRecord, reason: "removed" | "unavailable"): void {
		if (!leases.delete(record)) {return;}
		record.session = undefined;
		notifyLease(record, { kind: "closed", reason });
		record.listeners.clear();
	}

	function closeLeases(path: AgentPath, reason: "removed" | "unavailable"): void {
		for (const record of Array.from(leases)) {
			if (isPrefix(path, record.ref.path)) {closeLease(record, reason);}
		}
	}

	function rebindLeases(path: AgentPath): void {
		for (const record of Array.from(leases)) {
			if (pathKey(record.ref.path) !== pathKey(path)) {continue;}
			let borrowed: Borrowed;
			try {
				borrowed = borrow(record.ref);
			} catch (error) {
				console.error("[subagents] Lease rebind failed:", error);
				closeLease(record, "unavailable");
				continue;
			}
			record.session = borrowed.session;
			record.capabilities = borrowed.capabilities;
			notifyLease(record, { kind: "rebound", session: borrowed.session, capabilities: borrowed.capabilities });
		}
	}

	function updateReady(): void {
		if (ready || closed || !rootRestored || pendingRestores > 0) {return;}
		ready = true;
		publish({ sequence: ++sequence, kind: "ready" });
	}

	return {
		presenters,

		snapshot(): SubagentTopologySnapshot {
			const rootCwd = registry.getSnapshot([])?.cwd;
			return Object.freeze({
				sequence,
				ready,
				...(rootCwd ? { rootCwd } : undefined),
				nodes: Object.freeze([...nodes.values()]),
			});
		},

		subscribe(listener) {
			if (closed) {return () => undefined;}
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		async acquire(ref) {
			matchingNode(ref);
			const borrowed = borrow(ref);
			const record: LeaseRecord = {
				ref: { path: [...ref.path], incarnation: ref.incarnation },
				session: borrowed.session,
				capabilities: borrowed.capabilities,
				listeners: new Set(),
			};
			leases.add(record);
			const lease: SubagentLease = {
				path: record.ref.path,
				incarnation: record.ref.incarnation,
				get session(): BorrowedAgentSession {
					if (!record.session) {throw new Error("Subagent lease is closed");}
					return record.session;
				},
				get capabilities(): SubagentCapabilities {
					return record.capabilities;
				},
				subscribe(listener) {
					if (!leases.has(record)) {return () => undefined;}
					record.listeners.add(listener);
					return () => {
						record.listeners.delete(listener);
					};
				},
				release() {
					if (!leases.delete(record)) {return;}
					record.session = undefined;
					record.listeners.clear();
				},
			};
			return lease;
		},

		async teardown(ref): Promise<SubagentTeardownResult> {
			matchingNode(ref);
			return control.teardown({ path: [...ref.path], incarnation: ref.incarnation });
		},

		async stop(request: SubagentStopRequest): Promise<void> {
			const node = matchingNode(request);
			if (node.sessionId !== request.expectedSessionId) {throw new Error(`Stale subagent runtime for ${JSON.stringify(request.path)}`);}
			await control.stop({ ...request, path: [...request.path] });
		},

		async setHold(request: SubagentHoldRequest): Promise<void> {
			matchingNode(request);
			await control.setHold({ ...request, path: [...request.path] });
		},

		async resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult> {
			if (closed) {throw new Error("Subagent provider is shut down");}
			if (request.localId.length === 0 || request.localId === "parent" || request.localId.includes("/")) {
				throw new Error("Invalid resurrection local id");
			}
			return control.resurrect({ ...request, parentPath: [...request.parentPath], channels: [...request.channels] });
		},

		trackRestore(restore) {
			pendingRestores += 1;
			void restore.then(
				() => undefined,
				(error: unknown) => console.error("[subagents] Restore failed:", error),
			).finally(() => {
				pendingRestores -= 1;
				updateReady();
			});
		},

		markRootRestored() {
			rootRestored = true;
			updateReady();
		},

		shutdown() {
			if (closed) {return;}
			for (const record of Array.from(leases)) {closeLease(record, "unavailable");}
			closed = true;
			unsubscribe();
			listeners.clear();
			nodes.clear();
		},
	};
}

function pathKey(path: AgentPath): string {
	return JSON.stringify(path);
}

function isPrefix(prefix: AgentPath, path: AgentPath): boolean {
	return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function contextFill(lastTurnInput: number, contextWindow: number | undefined): number | undefined {
	if (!contextWindow || contextWindow <= 0) {return undefined;}
	return Math.max(0, Math.min(100, Math.round((lastTurnInput / contextWindow) * 100)));
}

function usageOf(usage: SubagentUsage): SubagentUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
		...(usage.costBreakdown ? { costBreakdown: { ...usage.costBreakdown } } : undefined),
		turns: usage.turns,
	};
}
