import { canSend, type Topology } from "./channels.js";
import { DeadlockGraph } from "./deadlock.js";

/**
 * A message delivered through a parent-local in-memory router. Every blocking
 * message has a correlationId; the router allocates one when the caller omits it.
 */
export type RoutedMessage = {
	from: string;
	message: string;
	correlationId?: string;
	responseExpected: boolean;
};

/** The response observed by the sender of a routed message. */
export type RoutedResponse =
	| { type: "response"; message: string }
	| { type: "error"; error: string };

/**
 * Receipt returned after a message has been accepted for delivery. A response
 * promise resolves with a typed error after accepted lifecycle/cancel failures;
 * only router shutdown rejects an already accepted unresolved wait.
 */
export type SendReceipt = {
	correlationId?: string;
	response?: Promise<RoutedResponse>;
};

/** The parent-local communication surface exposed to one scoped session. */
export interface MessagePort {
	readonly id: string;
	send(input: {
		to: string;
		message: string;
		expectResponse: boolean;
		correlationId?: string;
	}): Promise<SendReceipt>;
	/** Only the endpoint addressed by the correlation may respond. */
	respond(correlationId: string, message: string): Promise<void>;
	detach(correlationId: string): void;
	cancel(correlationId: string): void;
	subscribe(listener: (message: RoutedMessage) => void): () => void;
}

export interface MessageRouterOptions {
	topology: Topology;
	onBlockingSendStart?: (from: string, to: string, correlationId: string) => void;
	onBlockingSendEnd?: (from: string, correlationId: string) => void;
}

interface Endpoint {
	readonly id: string;
	readonly listeners: Set<(message: RoutedMessage) => void>;
	active: boolean;
}

interface PendingCorrelation {
	readonly correlationId: string;
	readonly from: string;
	readonly to: string;
	readonly resolve: (response: RoutedResponse) => void;
	readonly reject: (error: Error) => void;
	waitingEdgeAttached: boolean;
	waitingStatusEnded: boolean;
}

/**
 * Centralized parent-local routing authority for in-process subagent sessions.
 *
 * The router is deliberately a state holder at the transport boundary. All
 * routing decisions, pending waits, deadlock edges, endpoint subscriptions,
 * and lifecycle tombstones belong to one router instance; no process-global
 * state is involved.
 */
export class MessageRouter {
	private readonly topology: Topology;
	private readonly deadlockGraph = new DeadlockGraph();
	private readonly endpoints = new Map<string, Endpoint>();
	private readonly pendingCorrelations = new Map<string, PendingCorrelation>();
	private readonly unavailableAgents = new Map<string, string>();
	private readonly edgeCounts = new Map<string, Map<string, number>>();
	private readonly onBlockingSendStart?: MessageRouterOptions["onBlockingSendStart"];
	private readonly onBlockingSendEnd?: MessageRouterOptions["onBlockingSendEnd"];
	private nextCorrelationSequence = 0;
	private closed = false;

	constructor(options: MessageRouterOptions) {
		this.topology = options.topology;
		this.onBlockingSendStart = options.onBlockingSendStart;
		this.onBlockingSendEnd = options.onBlockingSendEnd;
	}

	/**
	 * Connect one endpoint in the current parent-local topology. A second
	 * connection for an already-live id is an adapter for the same endpoint;
	 * reconnecting a tombstoned id creates a fresh endpoint and clears its
	 * subscriptions and lifecycle failure state.
	 */
	connect(agentId: string): MessagePort {
		this.assertRouterOpen();
		if (!this.topology.has(agentId)) {
			throw new Error(`Unknown endpoint "${agentId}" is not present in the router topology`);
		}

		const existing = this.endpoints.get(agentId);
		if (existing?.active) {
			return this.createPort(existing);
		}

		this.unavailableAgents.delete(agentId);
		const endpoint: Endpoint = {
			id: agentId,
			listeners: new Set(),
			active: true,
		};
		this.endpoints.set(agentId, endpoint);
		return this.createPort(endpoint);
	}

	/**
	 * End waits addressed to an idle endpoint. Idling does not disconnect the
	 * endpoint: subsequent sends can still be delivered to the same session.
	 */
	agentIdle(agentId: string): void {
		if (this.closed) return;
		const error =
			`Agent "${agentId}" went idle without responding to your send. ` +
			"It either forgot to call respond, or chose not to. Its final output " +
			"was delivered via <agent_idle>; treat that as the answer, or send a " +
			"new message to prompt it again.";

		for (const pending of Array.from(this.pendingCorrelations.values())) {
			if (pending.to === agentId) {
				this.resolvePendingError(pending, error);
			}
		}
	}

	/**
	 * Mark an endpoint's runtime unavailable. Existing waits are completed with
	 * the supplied error, the endpoint is disconnected, and a replacement must
	 * reconnect before new sends are accepted.
	 */
	agentUnavailable(agentId: string, error: string): void {
		if (this.closed) return;
		const failure = error || `Agent "${agentId}" is unavailable`;
		this.unavailableAgents.set(agentId, failure);
		this.disconnectEndpoint(agentId);
		this.failCorrelationsForAgent(agentId, failure);
		this.removeEdgesForAgent(agentId);
	}

	/**
	 * Remove an endpoint permanently until a replacement with the same id
	 * reconnects. Both waits targeting the endpoint and waits issued by it are
	 * completed with typed lifecycle errors.
	 */
	agentRemoved(agentId: string): void {
		if (this.closed) return;
		const failure = `Agent "${agentId}" was removed`;
		this.unavailableAgents.set(agentId, failure);
		this.disconnectEndpoint(agentId);
		this.failCorrelationsForAgent(agentId, failure);
		this.removeEdgesForAgent(agentId);
	}

	isQuiet(): boolean {
		return this.pendingCorrelations.size === 0;
	}

	/**
	 * Reject all unresolved waits because the routing authority itself is gone.
	 * Unlike accepted lifecycle failures, router shutdown rejects the response
	 * promises. No topology or SDK/session state is changed here.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;

		for (const pending of Array.from(this.pendingCorrelations.values())) {
			this.rejectPendingForClose(pending);
		}
		this.pendingCorrelations.clear();
		this.edgeCounts.clear();

		for (const endpoint of this.endpoints.values()) {
			endpoint.active = false;
			endpoint.listeners.clear();
		}
		this.endpoints.clear();
	}

	private createPort(endpoint: Endpoint): MessagePort {
		return {
			id: endpoint.id,
			send: (input) => this.sendFrom(endpoint, input),
			respond: (correlationId, message) => this.respondFrom(endpoint, correlationId, message),
			detach: (correlationId) => this.detachFrom(endpoint, correlationId),
			cancel: (correlationId) => this.cancelFrom(endpoint, correlationId),
			subscribe: (listener) => this.subscribeTo(endpoint, listener),
		};
	}

	private async sendFrom(
		endpoint: Endpoint,
		input: {
			to: string;
			message: string;
			expectResponse: boolean;
			correlationId?: string;
		},
	): Promise<SendReceipt> {
		this.assertEndpointActive(endpoint);
		this.assertCanDeliver(endpoint.id, input.to);

		const target = this.endpoints.get(input.to);
		if (!target?.active) {
			throw new Error(`Agent "${input.to}" is not connected`);
		}

		if (!input.expectResponse) {
			this.deliverMessage(endpoint.id, target, input.message, input.correlationId, false);
			return {};
		}

		const correlationId = input.correlationId ?? this.allocateCorrelationId();
		if (this.pendingCorrelations.has(correlationId)) {
			throw new Error(`Correlation ID "${correlationId}" is already pending`);
		}
		if (this.deadlockGraph.wouldCauseCycle(endpoint.id, input.to)) {
			throw new Error(
				`Deadlock detected: blocking send from "${endpoint.id}" to "${input.to}" would create a cycle`,
			);
		}

		let resolveResponse!: (response: RoutedResponse) => void;
		let rejectResponse!: (error: Error) => void;
		const response = new Promise<RoutedResponse>((resolve, reject) => {
			resolveResponse = resolve;
			rejectResponse = reject;
		});
		const pending: PendingCorrelation = {
			correlationId,
			from: endpoint.id,
			to: input.to,
			resolve: resolveResponse,
			reject: rejectResponse,
			waitingEdgeAttached: true,
			waitingStatusEnded: false,
		};

		// Install every piece of blocking state before invoking callbacks or
		// listeners. A listener may answer synchronously during delivery.
		this.pendingCorrelations.set(correlationId, pending);
		this.addEdge(endpoint.id, input.to);
		this.invokeBlockingSendStart(endpoint.id, input.to, correlationId);
		this.deliverMessage(endpoint.id, target, input.message, correlationId, true);

		return { correlationId, response };
	}

	private async respondFrom(endpoint: Endpoint, correlationId: string, message: string): Promise<void> {
		this.assertEndpointActive(endpoint);
		const pending = this.pendingCorrelations.get(correlationId);
		if (!pending) {
			throw new Error(`No pending request for correlation ID "${correlationId}"`);
		}
		if (pending.to !== endpoint.id) {
			throw new Error(
				`Endpoint "${endpoint.id}" is not the target for correlation ID "${correlationId}"`,
			);
		}

		this.completePendingResponse(pending, message);
	}

	private detachFrom(endpoint: Endpoint, correlationId: string): void {
		if (!this.isEndpointActive(endpoint)) return;
		const pending = this.pendingCorrelations.get(correlationId);
		if (!pending || pending.from !== endpoint.id) return;
		this.endWaiting(pending);
	}

	private cancelFrom(endpoint: Endpoint, correlationId: string): void {
		if (!this.isEndpointActive(endpoint)) return;
		const pending = this.pendingCorrelations.get(correlationId);
		if (!pending || pending.from !== endpoint.id) return;
		this.resolvePendingError(
			pending,
			`Blocking send with correlation ID "${correlationId}" was cancelled`,
		);
	}

	private subscribeTo(endpoint: Endpoint, listener: (message: RoutedMessage) => void): () => void {
		if (!this.isEndpointActive(endpoint)) return () => undefined;
		endpoint.listeners.add(listener);
		return () => {
			endpoint.listeners.delete(listener);
		};
	}

	private assertRouterOpen(): void {
		if (this.closed) throw new Error("Message router is closed");
	}

	private assertEndpointActive(endpoint: Endpoint): void {
		if (this.closed) throw new Error("Message router is closed");
		if (!this.isEndpointActive(endpoint)) {
			throw new Error(`Endpoint "${endpoint.id}" is not connected`);
		}
	}

	private isEndpointActive(endpoint: Endpoint): boolean {
		return !this.closed && endpoint.active && this.endpoints.get(endpoint.id) === endpoint;
	}

	private assertCanDeliver(from: string, to: string): void {
		if (!canSend(this.topology, from, to)) {
			throw new Error(`Channel violation: "${from}" cannot send to "${to}"`);
		}

		const failure = this.unavailableAgents.get(to);
		if (failure !== undefined) throw new Error(failure);
	}

	private deliverMessage(
		from: string,
		target: Endpoint,
		message: string,
		correlationId: string | undefined,
		responseExpected: boolean,
	): void {
		const routed: RoutedMessage = { from, message, responseExpected };
		if (correlationId !== undefined) routed.correlationId = correlationId;

		// Take a snapshot so a listener can unsubscribe itself without changing
		// which listeners receive this already-accepted delivery.
		for (const listener of Array.from(target.listeners)) {
			try {
				listener(routed);
			} catch {
				// A subscriber is an extension boundary. One faulty listener must not
				// prevent the router from delivering to the remaining subscribers.
			}
		}
	}

	private allocateCorrelationId(): string {
		let correlationId: string;
		do {
			this.nextCorrelationSequence += 1;
			correlationId = `corr-${this.nextCorrelationSequence}`;
		} while (this.pendingCorrelations.has(correlationId));
		return correlationId;
	}

	private addEdge(from: string, to: string): void {
		let targets = this.edgeCounts.get(from);
		if (!targets) {
			targets = new Map();
			this.edgeCounts.set(from, targets);
		}
		const count = targets.get(to) ?? 0;
		if (count === 0) this.deadlockGraph.addEdge(from, to);
		targets.set(to, count + 1);
	}

	private removeEdge(from: string, to: string): void {
		const targets = this.edgeCounts.get(from);
		if (!targets) return;
		const count = targets.get(to);
		if (count === undefined) return;
		if (count <= 1) {
			targets.delete(to);
			this.deadlockGraph.removeEdge(from, to);
			if (targets.size === 0) this.edgeCounts.delete(from);
			return;
		}
		targets.set(to, count - 1);
	}

	private endWaiting(pending: PendingCorrelation): void {
		if (pending.waitingEdgeAttached) {
			this.removeEdge(pending.from, pending.to);
			pending.waitingEdgeAttached = false;
		}
		if (pending.waitingStatusEnded) return;
		pending.waitingStatusEnded = true;
		this.invokeBlockingSendEnd(pending.from, pending.correlationId);
	}

	private completePendingResponse(pending: PendingCorrelation, message: string): void {
		if (this.pendingCorrelations.get(pending.correlationId) !== pending) return;
		this.pendingCorrelations.delete(pending.correlationId);
		this.endWaiting(pending);
		pending.resolve({ type: "response", message });
	}

	private resolvePendingError(pending: PendingCorrelation, error: string): void {
		if (this.pendingCorrelations.get(pending.correlationId) !== pending) return;
		this.pendingCorrelations.delete(pending.correlationId);
		this.endWaiting(pending);
		pending.resolve({ type: "error", error });
	}

	private rejectPendingForClose(pending: PendingCorrelation): void {
		if (this.pendingCorrelations.get(pending.correlationId) !== pending) return;
		this.pendingCorrelations.delete(pending.correlationId);
		this.endWaiting(pending);
		pending.reject(new Error("Message router is closed"));
	}

	private failCorrelationsForAgent(agentId: string, error: string): void {
		for (const pending of Array.from(this.pendingCorrelations.values())) {
			if (pending.to === agentId || pending.from === agentId) {
				this.resolvePendingError(pending, error);
			}
		}
	}

	private removeEdgesForAgent(agentId: string): void {
		for (const [from, targets] of Array.from(this.edgeCounts.entries())) {
			if (from === agentId) {
				for (const to of targets.keys()) this.deadlockGraph.removeEdge(from, to);
				this.edgeCounts.delete(from);
				continue;
			}
			if (targets.has(agentId)) {
				targets.delete(agentId);
				this.deadlockGraph.removeEdge(from, agentId);
				if (targets.size === 0) this.edgeCounts.delete(from);
			}
		}
	}

	private disconnectEndpoint(agentId: string): void {
		const endpoint = this.endpoints.get(agentId);
		if (!endpoint) return;
		endpoint.active = false;
		endpoint.listeners.clear();
		this.endpoints.delete(agentId);
	}

	private invokeBlockingSendStart(from: string, to: string, correlationId: string): void {
		try {
			this.onBlockingSendStart?.(from, to, correlationId);
		} catch {
			// Status projection is observational; a callback failure must not leave
			// routing state half-installed or prevent message delivery.
		}
	}

	private invokeBlockingSendEnd(from: string, correlationId: string): void {
		try {
			this.onBlockingSendEnd?.(from, correlationId);
		} catch {
			// Keep terminal cleanup authoritative even when projection callbacks fail.
		}
	}
}
