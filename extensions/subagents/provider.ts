import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentPath } from "./agent-path.js";
import type { AgentSessionRegistry, AgentUsage } from "./agent-session-registry.js";
import type { SubagentLifecycleReader } from "./lifecycle.js";

/** Opaque provider epoch plus the last ordered event sequence observed in it. */
export type FeedCursor = Readonly<{
	epoch: string;
	sequence: number;
}>;

/** Native Pi transcript/session provenance for one semantic event. */
export type PiEventRef = Readonly<{
	sessionId: string;
	entryId?: string;
	toolCallId?: string;
	kind: "message" | "tool_call" | "custom_message" | "lifecycle";
}>;

export type SubagentEventKind =
	| "node_added"
	| "node_updated"
	| "node_removed"
	| "delegation"
	| "message_thread"
	| "await_started"
	| "child_settled"
	| "await_interrupted"
	| "await_released"
	| "completion"
	| "interrupt"
	| "teardown"
	| "resurrect";

export type DelegationData = Readonly<{
	invocationId: string;
	awaitsResult: boolean;
	children: readonly Readonly<{ path: AgentPath; task: string; persona?: string }>[];
}>;

export type CompletionData = Readonly<{
	status: "idle" | "errored" | "dead";
	output?: string;
	error?: string;
	usage?: SubagentUsage;
}> & (
	| Readonly<{ delivery: "awaited"; invocationId: string }>
	| Readonly<{ delivery: "asynchronous"; invocationId?: string }>
);

export type CommunicationData = Readonly<{
	from: AgentPath;
	to: AgentPath;
	text: string;
	correlationId?: string;
	responseExpected: boolean;
}> & (
	| Readonly<{ phase: "sent" | "received" | "response" }>
	| Readonly<{ phase: "failure"; error: string }>
);

export type SubagentEventData =
	| Readonly<{ kind: "delegation"; data: DelegationData }>
	| Readonly<{ kind: "message_thread"; data: CommunicationData }>
	| Readonly<{ kind: "node_updated"; data: Readonly<{ sessionId: string }> }>
	| Readonly<{ kind: "completion"; data: CompletionData }>
	| Readonly<{
			kind: Exclude<SubagentEventKind, "delegation" | "message_thread" | "node_updated" | "completion">;
			data: unknown;
	  }>;

/** A semantic overlay. Native Pi entries remain the transcript source. */
export type SubagentSemanticFact = Readonly<{
	eventId: string;
	path: AgentPath;
	relatedPiEvents: readonly PiEventRef[];
}> & SubagentEventData;

export type SubagentEvent = SubagentSemanticFact & Readonly<{ cursor: FeedCursor }>;

export type SubagentState = "running" | "waiting" | "idle" | "errored" | "dead";

/** Public usage projection carried by provider snapshots. */
export type SubagentUsage = Readonly<AgentUsage>;

/** Current public projection of one root-relative child path. */
export type SubagentNodeSnapshot = Readonly<{
	path: AgentPath;
	sessionId: string;
	task?: string;
	persona?: string;
	personaIcon?: string;
	model?: string;
	thinkingLevel?: string;
	state: SubagentState;
	activity?: string;
	usage: SubagentUsage;
	/** Context fill as an integer percentage from 0 through 100. */
	contextFill?: number;
	channels: readonly string[];
	waitingFor: readonly AgentPath[];
	pendingCorrelations: readonly string[];
	hasSubgroup: boolean;
	lastOutput?: string;
	lastError?: string;
}>;

/** Snapshot boundary for the current provider epoch. */
export type SubagentSnapshot = Readonly<{
	cursor: FeedCursor;
	nodes: readonly SubagentNodeSnapshot[];
}>;

export type ReplayResult =
	| Readonly<{
			kind: "events";
			cursor: FeedCursor;
			events: readonly SubagentEvent[];
	  }>
	| Readonly<{
			kind: "snapshot_required";
			reason: "epoch_changed" | "history_unavailable";
	  }>;

export type SubagentTeardownResult = Readonly<{
	path: AgentPath;
	removed: boolean;
	sessionId?: string;
	reason?: "not_found" | "already_removed" | "removed";
}>;

/** Structural projection of the native child runtime borrowed by a view. */
export type BorrowedAgentSession =
	Pick<
		AgentSession,
		| "sessionId"
		| "sessionFile"
		| "messages"
		| "model"
		| "thinkingLevel"
		| "isStreaming"
		| "isIdle"
		| "isCompacting"
		| "subscribe"
		| "prompt"
		| "steer"
		| "followUp"
		| "abort"
		| "executeBash"
		| "abortBash"
		| "setModel"
		| "cycleModel"
		| "setThinkingLevel"
		| "cycleThinkingLevel"
		| "setAutoCompactionEnabled"
		| "compact"
		| "navigateTree"
		| "getContextUsage"
		| "getSessionStats"
	> & {
		readonly sessionManager: Pick<
			AgentSession["sessionManager"],
			"getEntries" | "getBranch" | "buildContextEntries" | "getTree" | "getLeafId" | "getCwd" | "getLabel" | "appendLabelChange"
		>;
	};

export type SubagentLeaseEvent =
	| Readonly<{ kind: "rebound"; session: BorrowedAgentSession }>
	| Readonly<{ kind: "closed"; reason: "removed" | "unavailable" }>;

export interface SubagentLease {
	readonly path: AgentPath;
	/** Current native session. Access throws after the lease closes or releases. */
	readonly session: BorrowedAgentSession;
	subscribe(listener: (event: SubagentLeaseEvent) => void): () => void;
	release(): Promise<void>;
}

export interface SubagentProvider {
	subscribe(listener: (event: SubagentEvent) => void): () => void;
	snapshot(): SubagentSnapshot;
	/** Without a cursor, replay all retained events. */
	replay(after?: FeedCursor): ReplayResult;
	acquire(path: AgentPath): Promise<SubagentLease>;
	teardown(path: AgentPath): Promise<SubagentTeardownResult>;
}

export interface SubagentProviderOptions {
	/** Canonical root-relative tree and live child runtime owner. */
	registry: AgentSessionRegistry;
	/** Existing append-only lifecycle projection used for replay restoration. */
	lifecycle?: SubagentLifecycleReader;
	/** Parent session file used to locate persisted child sessions. */
	parentSessionFile?: string;
	/** Live semantic facts, independent of child view leases. */
	semanticEvents?: { subscribe(listener: (fact: SubagentSemanticFact) => void): () => void };
	/** Maximum retained feed events, a positive integer. Older cursors require a snapshot. */
	historyLimit?: number;
}

/** Provider construction seam. Runtime behavior is intentionally deferred. */
export function createSubagentProvider(_options: SubagentProviderOptions): SubagentProvider {
	throw new Error("not implemented");
}
