import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentPath } from "./agent-path.js";
export type { AgentPath } from "./agent-path.js";
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
	| "runtime_replaced"
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

export type SubagentDelegationData = Readonly<{
	invocationId: string;
	awaitsResult: boolean;
	children: readonly Readonly<{ path: AgentPath; task: string; persona?: string }>[];
}>;

/** Alias used by the my-pi provider implementation. */
export type DelegationData = SubagentDelegationData;

export type SubagentCompletionData = Readonly<{
	status: "idle" | "errored" | "dead" | "stopped";
	output?: string;
	error?: string;
	usage?: SubagentUsage;
}> &
	(
		| Readonly<{ delivery: "awaited"; invocationId: string }>
		| Readonly<{ delivery: "asynchronous"; invocationId?: string }>
	);

/** Alias used by the my-pi provider implementation. */
export type CompletionData = SubagentCompletionData;

export type SubagentMessageData = Readonly<{
	from: AgentPath;
	to: AgentPath;
	text: string;
	correlationId?: string;
	responseExpected: boolean;
}> &
	(
		| Readonly<{ phase: "sent" | "received" | "response" }>
		| Readonly<{ phase: "failure"; error: string }>
	);

/** Alias used by the my-pi provider implementation. */
export type CommunicationData = SubagentMessageData;

/** One child state included in await progress and settlement facts. */
export type SubagentAwaitState = SubagentState | "stopped";

export type SubagentAwaitChildStatus = Readonly<{
	path: AgentPath;
	state: SubagentAwaitState;
	output?: string;
	error?: string;
	sessionId?: string;
}>;

/** Await progress, interruption, and release details. */
export type SubagentAwaitData = Readonly<{
	invocationId?: string;
	requested?: readonly AgentPath[];
	statuses?: readonly SubagentAwaitChildStatus[];
	path?: AgentPath;
	output?: string;
	error?: string;
	reason?: "settled" | "detach" | "stop" | "message";
	message?: CommunicationData;
	[key: string]: unknown;
}>;

/** Lifecycle operation details carried by interrupt, teardown, and resurrection facts. */
export type SubagentLifecycleData = Readonly<{
	operation?: "interrupt" | "teardown" | "resurrect";
	outcome?: string;
	path?: AgentPath;
	output?: string;
	error?: string;
	sessionId?: string;
	recovery?: Readonly<Record<string, unknown>>;
	[key: string]: unknown;
}>;

/**
 * A public node projection carried by topology events and snapshots.
 * `incarnation` changes when a path is removed or reused, but survives runtime
 * replacement at the same path.
 */
export type SubagentNodeSnapshot = Readonly<{
	path: AgentPath;
	incarnation: string;
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

/**
 * Topology events use complete node snapshots. The small session-id form stays
 * accepted for old persisted semantic facts that predate complete snapshots.
 */
/** Compatibility alias for consumers that call hierarchy rows nodes. */
export type SubagentNode = SubagentNodeSnapshot;

/** Topology events accept the complete projection and old session-id facts. */
export type SubagentNodeEventData =
	| SubagentNodeSnapshot
	| Readonly<{ sessionId: string }>;

export type SubagentRuntimeReplacedData = Readonly<{
	oldSessionId: string;
	newSessionId: string;
}>;

export type SubagentUsageSnapshot = SubagentUsage;

export type SubagentEventData =
	| Readonly<{ kind: "node_added" | "node_updated"; data: SubagentNodeEventData }>
	| Readonly<{
			kind: "node_removed";
			data: Readonly<{ node: SubagentNodeSnapshot; reason: string }>;
	  }>
	| Readonly<{ kind: "runtime_replaced"; data: SubagentRuntimeReplacedData }>
	| Readonly<{ kind: "delegation"; data: DelegationData }>
	| Readonly<{ kind: "message_thread"; data: CommunicationData }>
	| Readonly<{
			kind: "await_started" | "child_settled" | "await_interrupted" | "await_released";
			data: SubagentAwaitData;
	  }>
	| Readonly<{
			kind: "completion";
			data: CompletionData;
	  }>
	| Readonly<{
			kind: "interrupt" | "teardown" | "resurrect";
			data: SubagentLifecycleData;
	  }>;

/** A semantic overlay. Native Pi entries remain the transcript source. */
export type SubagentSemanticFact = Readonly<{
	eventId: string;
	path: AgentPath;
	relatedPiEvents: readonly PiEventRef[];
}> &
	SubagentEventData;

/** A typed live feed event with its provider-owned replay cursor. */
export type SubagentEvent = SubagentSemanticFact & Readonly<{ cursor: FeedCursor }>;

export type SubagentState = "running" | "waiting" | "idle" | "errored" | "dead";
export type SubagentNodeState = SubagentState;

export type SubagentCostBreakdown = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}>;

/** Public usage projection carried by provider snapshots. */
export type SubagentUsage = Readonly<AgentUsage>;

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

export type SubagentTeardownReason = "not_found" | "already_removed" | "removed";

export type SubagentTeardownResult = Readonly<{
	path: AgentPath;
	removed: boolean;
	sessionId?: string;
	incarnation?: string;
	reason?: SubagentTeardownReason;
}>;

/** Guarded request to stop the child that owns one public path incarnation. */
export type SubagentStopRequest = Readonly<{
	path: AgentPath;
	incarnation: string;
	/** The host must reject a request for a replacement runtime at this path. */
	expectedSessionId: string;
}>;

/** Input to the normal my-pi resurrection path. */
export type SubagentResurrectRequest = Readonly<{
	/** Saved child session id returned by teardown. */
	sessionId: string;
	/** Owning root-relative parent path. */
	parentPath: AgentPath;
	/** New local id under `parentPath`. */
	localId: string;
	task: string;
	channels: readonly string[];
	model?: string;
}>;

/** Result of a normal resurrection operation. */
export type SubagentResurrectResult = Readonly<{
	path: AgentPath;
	node?: SubagentNodeSnapshot;
	sessionId?: string;
	incarnation?: string;
}>;

/**
 * Provider-owned child capabilities. The projection is intentionally separate
 * from the borrowed AgentSession so Pimote never receives extension machinery.
 */
export type SubagentOperation =
	| "prompt"
	| "steer"
	| "follow_up"
	| "stop"
	| "bash"
	| "abort_bash"
	| "set_model"
	| "cycle_model"
	| "set_thinking_level"
	| "cycle_thinking_level"
	| "set_auto_compaction"
	| "compact"
	| "tree"
	| "completion"
	| "state"
	| "meta";

export interface SubagentCapabilities {
	/** Explicitly admitted identity-preserving operations. */
	readonly operations?: readonly SubagentOperation[];
	/** Whether the child renderer can expose a view. */
	readonly renderer?: Readonly<{ visible?: boolean; [key: string]: unknown }>;
	/** Child-local model resolution and settings. */
	readonly resolveModel?: (provider: string, modelId: string) => Promise<unknown> | unknown;
	readonly getSettings?: () => unknown;
	/** Native bash admission and dispatch. */
	readonly nativeBash?: Readonly<{
		admitted?: boolean;
		execute?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
		abort?: (...args: readonly unknown[]) => Promise<void> | void;
		[key: string]: unknown;
	}>;
	readonly executeBash?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
	/** Filtered command and argument-completion descriptors. */
	readonly getCommands?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
	readonly completeArgs?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
	readonly completeFileRefs?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
	readonly [key: string]: unknown;
}

/** Minimal session-manager projection exposed beside a borrowed native session. */
export type BorrowedSessionManager = Pick<
	AgentSession["sessionManager"],
	"getEntries" | "getBranch" | "buildContextEntries" | "getTree" | "getLeafId" | "getCwd" | "getLabel" | "appendLabelChange"
>;

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
		readonly sessionManager: BorrowedSessionManager;
		readonly state: Pick<AgentSession["state"], "streamingMessage" | "pendingToolCalls" | "errorMessage">;
	};

export type SubagentLeaseEvent =
	| Readonly<{ kind: "rebound"; session: BorrowedAgentSession; capabilities?: SubagentCapabilities }>
	| Readonly<{ kind: "closed"; reason: "removed" | "unavailable" }>;

export interface SubagentLease {
	readonly path: AgentPath;
	/** Current native session; access throws after the lease closes or releases. */
	readonly session: BorrowedAgentSession;
	readonly capabilities: SubagentCapabilities;
	subscribe(listener: (event: SubagentLeaseEvent) => void): () => void;
	/** Idempotent. Never disposes the borrowed child runtime. */
	release(): Promise<void>;
}

/** Root-scoped semantic facts shared by every nested manager. */
export interface SubagentSemanticFactBus {
	publish(fact: SubagentSemanticFact): void;
	subscribe(listener: (fact: SubagentSemanticFact) => void): () => void;
}

/** Root-scoped lifecycle authority used by the provider. */
/** Operations a manager exposes to the root-scoped control registry.
 *
 * The control registry supplies the owning manager's local id after resolving
 * the public root-relative path. These methods run through the manager's own
 * mutation queue; callers never remove registry nodes directly.
 */
export interface SubagentManagerControl {
	teardown(localId: string, incarnation: string): Promise<SubagentTeardownResult>;
	stop(request: SubagentStopRequest): Promise<void>;
	resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult>;
}

export interface SubagentOwnerControlPort {
	teardown(path: AgentPath, incarnation: string): Promise<SubagentTeardownResult>;
	stop(request: SubagentStopRequest): Promise<void>;
	resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult>;
	/** Register one immediate-child owner at its canonical root-relative path. */
	registerManager?(ownerPath: AgentPath, manager: SubagentManagerControl): void;
	/** Remove a manager registration during scope shutdown. */
	unregisterManager?(ownerPath: AgentPath, manager: SubagentManagerControl): void;
}

export interface SubagentProvider {
	subscribe(listener: (event: SubagentEvent) => void): () => void;
	snapshot(): SubagentSnapshot;
	/** Without a cursor, replay all retained events. */
	replay(after?: FeedCursor): ReplayResult;
	acquire(path: AgentPath): Promise<SubagentLease>;
	teardown(path: AgentPath, incarnation: string): Promise<SubagentTeardownResult>;
	stop(request: SubagentStopRequest): Promise<void>;
	resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult>;
}

export interface SubagentProviderOptions {
	/** Canonical root-relative tree and live child runtime owner. */
	registry: AgentSessionRegistry;
	/** Root-scoped lifecycle authority. Provider delegates guarded mutations here. */
	ownerControl: SubagentOwnerControlPort;
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
