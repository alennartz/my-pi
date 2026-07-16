import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentPath } from "./agent-path.js";
import type {
	ChildSessionConfig,
	ChildSessionHooks,
	ManagedChildSession,
	ManagedChildSessionDependencies,
	createManagedChildSession,
} from "./managed-child-session.js";
import type { DelegatingExtensionUI } from "./delegating-extension-ui.js";
import type { MessagePort } from "./message-router.js";

export type NodeOwnership = "external" | "registry";

export type AgentUsage = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}>;

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
	| {
		type: "node_updated";
		previous: AgentNodeSnapshot;
		node: AgentNodeSnapshot;
	}
	| { type: "node_removed"; node: AgentNodeSnapshot };

export type ExternalRootNode = {
	readonly snapshot: AgentNodeSnapshot & { ownership: "external" };
};

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
	session: Omit<ChildSessionConfig, "path" | "scope"> & {
		uplink: MessagePort;
	};
	/** Path-bound lifecycle callbacks owned by the parent manager. */
	hooks: ChildSessionHooks;
	initialOperational: AgentOperationalSnapshot;
};

export type AgentSessionRegistryOptions = {
	root: AgentNodeSnapshot & { path: []; ownership: "external" };
	dependencies: ManagedChildSessionDependencies;
	createSession?: typeof createManagedChildSession;
};

/**
 * Owns the live root-relative AgentSession tree without owning persistence or
 * parent-local message topology.
 */
export class AgentSessionRegistry {
	constructor(_options: AgentSessionRegistryOptions) {
		throw new Error("not implemented");
	}

	get(_path: AgentPath): AgentRegistryNode | undefined {
		throw new Error("not implemented");
	}

	getSnapshot(_path: AgentPath): AgentNodeSnapshot | undefined {
		throw new Error("not implemented");
	}

	listChildren(_parent: AgentPath): AgentNodeSnapshot[] {
		throw new Error("not implemented");
	}

	createChildren(
		_parent: AgentPath,
		_requests: CreateAgentNodeRequest[],
	): Promise<RegisteredAgentNode[]> {
		throw new Error("not implemented");
	}

	updateOperational(_path: AgentPath, _next: AgentOperationalSnapshot): void {
		throw new Error("not implemented");
	}

	remove(_path: AgentPath): Promise<void> {
		throw new Error("not implemented");
	}

	attachPresentation(_path: AgentPath, _target: ExtensionUIContext): () => void {
		throw new Error("not implemented");
	}

	subscribe(_listener: (event: RegistryEvent) => void): () => void {
		throw new Error("not implemented");
	}

	dispose(): Promise<void> {
		throw new Error("not implemented");
	}
}
