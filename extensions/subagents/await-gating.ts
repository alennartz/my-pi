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
			reason: "detach" | "stop";
			statuses: readonly AwaitChildStatus[];
	  }>
	| Readonly<{
			kind: "interrupted";
			message: AwaitMessage;
			statuses: readonly AwaitChildStatus[];
	  }>;

export interface AwaitGateOptions {
	requested: readonly AgentPath[];
	attached?: readonly AgentPath[];
}

/**
 * View-aware await coordination. Lease state is internal coordination, not
 * transcript copy: callers observe only the eventual outcome and statuses.
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
