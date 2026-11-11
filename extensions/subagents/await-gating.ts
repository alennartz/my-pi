import type { AgentPath } from "./agent-path.js";

export type AwaitChildState = "idle" | "errored" | "dead";

export type AwaitChildStatus = Readonly<{
	path: AgentPath;
	state: AwaitChildState;
	output?: string;
	error?: string;
	sessionId?: string;
}>;

export type AwaitMessage = Readonly<{
	from: AgentPath;
	to: AgentPath;
	content: string;
	correlationId?: string;
	responseExpected: boolean;
}>;

export type AwaitOutcome =
	| Readonly<{
			kind: "released";
			reason: "settled" | "detach" | "stop";
			statuses: readonly AwaitChildStatus[];
	  }>
	| Readonly<{
			kind: "interrupted";
			message: AwaitMessage;
			statuses: readonly AwaitChildStatus[];
	  }>;

export interface AwaitGateOptions {
	/** Empty when no parent await is active. */
	requested: readonly AgentPath[];
	/** Each occurrence represents one client lease. */
	attached?: readonly AgentPath[];
	/** Deliver the latest held idle notification after the final lease detaches. */
	onHeldIdleDelivery?: (status: AwaitChildStatus) => void;
}

/**
 * View-aware await and idle notification coordination. The gate continues
 * holding notifications after its result resolves, including when no await
 * is active. A message interrupts the wait without discarding held idle
 * notifications. Stop discards them.
 */
export interface AwaitGate {
	readonly result: Promise<AwaitOutcome>;
	attach(path: AgentPath): void;
	settle(status: AwaitChildStatus): void;
	message(message: AwaitMessage): void;
	detach(path: AgentPath): void;
	stop(): void;
}

/** Await construction seam. Runtime gating is intentionally deferred. */
export function createAwaitGate(_options: AwaitGateOptions): AwaitGate {
	throw new Error("not implemented");
}
