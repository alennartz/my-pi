import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { childAgentPath, type AgentPath } from "./agent-path.js";
import {
	createManagedChildSession,
	type ChildSessionConfig,
	type ChildSessionHooks,
	type ManagedChildSession,
	type ManagedChildSessionDependencies,
} from "./managed-child-session.js";
import type { DelegatingExtensionUI } from "./delegating-extension-ui.js";
import type { MessagePort } from "./message-router.js";

export type NodeOwnership = "external" | "registry";
export type AgentUsage = Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }>;
export type AgentOperationalSnapshot = Readonly<{
	state: "running" | "idle" | "waiting" | "failed";
	usage: AgentUsage;
	model?: string;
	lastActivity?: string;
	lastOutput?: string;
	lastError?: string;
	lastTurnInput: number;
	contextWindow?: number;
	hasSubgroup: boolean;
	pendingCorrelations: readonly string[];
	waitingFor: readonly string[];
}>;
export type AgentNodeSnapshot = Readonly<{
	path: AgentPath;
	parentPath: AgentPath | null;
	localId: string | null;
	ownership: NodeOwnership;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	task?: string;
	agentDef?: string;
	channels: readonly string[];
	operational: AgentOperationalSnapshot;
}>;
export type RegistryEvent =
	| { type: "node_added"; node: AgentNodeSnapshot }
	| { type: "node_updated"; previous: AgentNodeSnapshot; node: AgentNodeSnapshot }
	| { type: "node_removed"; node: AgentNodeSnapshot };
export type ExternalRootNode = { readonly snapshot: AgentNodeSnapshot & { ownership: "external" } };
export type RegisteredAgentNode = {
	readonly snapshot: AgentNodeSnapshot & { ownership: "registry" };
	readonly session: ManagedChildSession;
	readonly presentation: DelegatingExtensionUI;
};
export type AgentRegistryNode = ExternalRootNode | RegisteredAgentNode;
export type CreateAgentNodeRequest = {
	localId: string;
	task: string;
	agentDef?: string;
	channels: string[];
	session: Omit<ChildSessionConfig, "path" | "scope"> & { uplink: MessagePort };
	hooks: ChildSessionHooks;
	initialOperational: AgentOperationalSnapshot;
};
export type AgentSessionRegistryOptions = {
	root: AgentNodeSnapshot & { path: []; ownership: "external" };
	dependencies: ManagedChildSessionDependencies;
	createSession?: typeof createManagedChildSession;
};

type InternalNode = {
	snapshot: AgentNodeSnapshot;
	session: ManagedChildSession;
	presentation: DelegatingExtensionUI;
	disposing?: Promise<void>;
};

function key(path: AgentPath): string { return JSON.stringify(path); }
function samePath(a: AgentPath, b: AgentPath): boolean { return a.length === b.length && a.every((part, i) => part === b[i]); }
function isPrefix(prefix: AgentPath, path: AgentPath): boolean { return prefix.length <= path.length && prefix.every((part, i) => part === path[i]); }
function cloneFreeze<T>(value: T): T {
	if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneFreeze(item))) as T;
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [name, child] of Object.entries(value as Record<string, unknown>)) result[name] = cloneFreeze(child);
		return Object.freeze(result) as T;
	}
	return value;
}
function snapshotEqual(a: AgentNodeSnapshot, b: AgentNodeSnapshot): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export class AgentSessionRegistry {
	private readonly dependencies: ManagedChildSessionDependencies;
	private readonly createSession: typeof createManagedChildSession;
	private readonly root: ExternalRootNode;
	private readonly nodes = new Map<string, InternalNode>();
	private readonly reservations = new Set<string>();
	private readonly listeners = new Set<(event: RegistryEvent) => void>();
	private readonly removals = new Map<string, Promise<void>>();
	private disposal?: Promise<void>;

	constructor(options: AgentSessionRegistryOptions) {
		if (options.root.path.length !== 0 || options.root.ownership !== "external") throw new Error("Registry root must be external path []");
		const rootSnapshot = cloneFreeze({ ...options.root, path: [], parentPath: null, ownership: "external" }) as AgentNodeSnapshot & { ownership: "external"; path: [] };
		this.root = { get snapshot() { return rootSnapshot; } };
		this.dependencies = options.dependencies;
		this.createSession = options.createSession ?? createManagedChildSession;
	}

	get(path: AgentPath): AgentRegistryNode | undefined {
		if (path.length === 0) return this.root;
		const node = this.nodes.get(key(path));
		if (!node) return undefined;
		return this.publicNode(node);
	}

	getSnapshot(path: AgentPath): AgentNodeSnapshot | undefined {
		return this.get(path)?.snapshot;
	}

	listChildren(parent: AgentPath): AgentNodeSnapshot[] {
		const result: AgentNodeSnapshot[] = [];
		for (const node of this.nodes.values()) {
			if (node.snapshot.parentPath && samePath(node.snapshot.parentPath, parent)) result.push(node.snapshot);
		}
		return result;
	}

	async createChildren(parent: AgentPath, requests: CreateAgentNodeRequest[]): Promise<RegisteredAgentNode[]> {
		if (!this.get(parent)) throw new Error(`Unknown parent path ${JSON.stringify(parent)}`);
		const localIds = new Set<string>();
		const paths: AgentPath[] = [];
		for (const request of requests) {
			if (request.localId === "parent") throw new Error("Reserved parent agent ID");
			if (localIds.has(request.localId)) throw new Error(`Duplicate sibling id ${request.localId}`);
			localIds.add(request.localId);
			const path = childAgentPath(parent, request.localId);
			const pathKey = key(path);
			if (this.nodes.has(pathKey) || this.reservations.has(pathKey)) throw new Error(`Duplicate or reserved sibling path ${request.localId}`);
			paths.push(path);
		}
		for (const path of paths) this.reservations.add(key(path));
		const staged = new Map<string, InternalNode>();
		const created: InternalNode[] = [];
		try {
			for (let index = 0; index < requests.length; index++) {
				const request = requests[index];
				const path = paths[index];
				const pathKey = key(path);
				let currentSnapshot = cloneFreeze({
					path: [...path],
					parentPath: [...parent],
					localId: request.localId,
					ownership: "registry" as const,
					sessionId: "",
					cwd: request.session.target.kind === "resume" ? "" : request.session.target.cwd,
					task: request.task,
					agentDef: request.agentDef,
					channels: [...request.channels],
					operational: request.initialOperational,
				}) as AgentNodeSnapshot;
				const decoratedHooks: ChildSessionHooks = {
					onEvent: request.hooks.onEvent,
					onUiNotify: request.hooks.onUiNotify,
					onShutdownRequested: request.hooks.onShutdownRequested,
					onSessionChanged: (metadata) => {
						const previous = currentSnapshot;
						currentSnapshot = cloneFreeze({ ...currentSnapshot, sessionId: metadata.sessionId, sessionFile: metadata.sessionFile, cwd: metadata.cwd }) as AgentNodeSnapshot;
						const liveNode = this.nodes.get(pathKey);
						if (liveNode && !snapshotEqual(previous, currentSnapshot)) {
							liveNode.snapshot = currentSnapshot;
							this.emit({ type: "node_updated", previous, node: currentSnapshot });
						}
						request.hooks.onSessionChanged(metadata);
					},
				};
				const config: ChildSessionConfig = {
					...request.session,
					path,
					scope: {
						kind: "child",
						registry: this,
						path,
						identity: { id: request.localId, task: request.task, channels: [...request.channels] },
						uplink: request.session.uplink,
					},
				};
				const session = await this.createSession(config, this.dependencies, decoratedHooks);
				const managed = session as ManagedChildSession;
				const sessionObject: any = (managed as any).session;
				const sessionId = (managed as any).sessionId ?? sessionObject?.sessionId ?? currentSnapshot.sessionId;
				const sessionFile = (managed as any).sessionFile ?? sessionObject?.sessionFile;
				const manager = sessionObject?.sessionManager;
				const cwd = manager?.getCwd?.() || currentSnapshot.cwd || (request.session.target.kind === "resume" ? "" : request.session.target.cwd);
				currentSnapshot = cloneFreeze({ ...currentSnapshot, sessionId, ...(sessionFile !== undefined ? { sessionFile } : {}), cwd }) as AgentNodeSnapshot;
				const presentation = (managed as any).presentation as DelegatingExtensionUI;
				const node: InternalNode = { snapshot: currentSnapshot, session: managed, presentation };
				staged.set(pathKey, node);
				created.push(node);
			}
			for (const path of paths) this.reservations.delete(key(path));
			for (const path of paths) {
				const node = staged.get(key(path))!;
				this.nodes.set(key(path), node);
				this.emit({ type: "node_added", node: node.snapshot });
			}
			return created.map((node) => this.publicNode(node) as RegisteredAgentNode);
		} catch (error) {
			for (const node of created) {
				try { await node.session.dispose(); } catch { /* preserve original construction failure */ }
			}
			for (const path of paths) this.reservations.delete(key(path));
			throw error;
		}
	}

	updateOperational(path: AgentPath, next: AgentOperationalSnapshot): void {
		const node = this.nodes.get(key(path));
		if (!node) return;
		const snapshot = cloneFreeze({ ...node.snapshot, operational: next }) as AgentNodeSnapshot;
		if (snapshotEqual(node.snapshot, snapshot)) return;
		const previous = node.snapshot;
		node.snapshot = snapshot;
		this.emit({ type: "node_updated", previous, node: snapshot });
	}

	remove(path: AgentPath): Promise<void> {
		if (path.length === 0) return Promise.reject(new Error("Cannot remove external root"));
		const pathKey = key(path);
		const existing = this.removals.get(pathKey);
		if (existing) return existing;
		const operation = (async () => {
			const targets = [...this.nodes.entries()]
				.filter(([, node]) => isPrefix(path, node.snapshot.path))
				.sort((a, b) => b[1].snapshot.path.length - a[1].snapshot.path.length);
			for (const [nodeKey, node] of targets) {
				if (!this.nodes.has(nodeKey)) continue;
				try { await node.session.dispose(); } catch { /* removal remains best effort */ }
				this.nodes.delete(nodeKey);
				this.emit({ type: "node_removed", node: node.snapshot });
			}
		})().finally(() => this.removals.delete(pathKey));
		this.removals.set(pathKey, operation);
		return operation;
	}

	attachPresentation(path: AgentPath, target: ExtensionUIContext): () => void {
		const node = this.nodes.get(key(path));
		if (!node) throw new Error("Presentation attachment requires a live registry-owned descendant");
		return node.presentation.attach(target);
	}

	subscribe(listener: (event: RegistryEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposal = (async () => {
			const topLevel = [...this.nodes.values()]
				.filter((node) => node.snapshot.parentPath && node.snapshot.parentPath.length === 0)
				.map((node) => node.snapshot.path);
			for (const path of topLevel) await this.remove(path);
		})();
		return this.disposal;
	}

	private publicNode(node: InternalNode): RegisteredAgentNode {
		return {
			get snapshot() { return node.snapshot as RegisteredAgentNode["snapshot"]; },
			session: node.session,
			presentation: node.presentation,
		};
	}

	private emit(event: RegistryEvent): void {
		for (const listener of this.listeners) {
			try { listener(event); } catch { /* observers cannot interrupt lifecycle */ }
		}
	}
}
