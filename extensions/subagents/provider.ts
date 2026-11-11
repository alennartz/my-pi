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
	| "message_thread"
	| "await_started"
	| "child_settled"
	| "await_interrupted"
	| "await_released"
	| "completion"
	| "interrupt"
	| "teardown"
	| "resurrect";

/** A semantic overlay. Native Pi entries remain the transcript source. */
export type SubagentEvent = Readonly<{
	eventId: string;
	cursor: FeedCursor;
	path: AgentPath;
	kind: SubagentEventKind;
	relatedPiEvents: readonly PiEventRef[];
	data: unknown;
}>;

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
	/** Context fill as a ratio or percentage chosen by the provider contract. */
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
		| "abort"
		| "setModel"
		| "setThinkingLevel"
		| "compact"
		| "navigateTree"
		| "getContextUsage"
		| "getSessionStats"
	> & {
		readonly sessionManager: Pick<
			AgentSession["sessionManager"],
			"getEntries" | "getBranch" | "buildContextEntries" | "getTree" | "getLeafId"
		>;
	};

export interface SubagentLease {
	readonly path: AgentPath;
	readonly session: BorrowedAgentSession;
	release(): Promise<void>;
}

export interface SubagentProvider {
	subscribe(listener: (event: SubagentEvent) => void): () => void;
	snapshot(): SubagentSnapshot;
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
}

/** Provider construction seam. Runtime behavior is intentionally deferred. */
export function createSubagentProvider(_options: SubagentProviderOptions): SubagentProvider {
	throw new Error("not implemented");
}
