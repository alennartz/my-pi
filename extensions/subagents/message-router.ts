import type { Topology } from "./channels.js";

/** A message delivered through a parent-local in-memory router. */
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

/** Receipt returned after a message has been accepted for delivery. */
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

/**
 * Centralized parent-local routing authority for in-process subagent sessions.
 *
 * This phase materializes the public contract only. The implementation will
 * own channel authorization, correlation lifetimes, and deadlock state.
 */
export class MessageRouter {
	constructor(_options: MessageRouterOptions) {
		throw new Error("not implemented");
	}

	connect(_agentId: string): MessagePort {
		throw new Error("not implemented");
	}

	agentIdle(_agentId: string): void {
		throw new Error("not implemented");
	}

	agentUnavailable(_agentId: string, _error: string): void {
		throw new Error("not implemented");
	}

	agentRemoved(_agentId: string): void {
		throw new Error("not implemented");
	}

	isQuiet(): boolean {
		throw new Error("not implemented");
	}

	close(): void {
		throw new Error("not implemented");
	}
}
