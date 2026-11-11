import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentPath } from "./agent-path.js";
export type { AgentPath } from "./agent-path.js";
import type {
	AgentNodeSnapshot,
	AgentSessionRegistry,
	AgentUsage,
	RegisteredAgentNode,
	RegistryEvent,
} from "./agent-session-registry.js";
import { getPersistencePaths } from "./persistence.js";
import { createSemanticEvent } from "./semantic-events.js";
import {
	createSubagentLifecycleReader,
	type SubagentLifecycleRecord,
	type SubagentLifecycleReader,
} from "./lifecycle.js";
import type { ManagedChildSession } from "./managed-child-session.js";

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

type ProviderNode = SubagentNodeSnapshot;
type NodeIdentity = Readonly<{ incarnation: string; explicit: boolean }>;
type LeaseRecord = {
	readonly path: AgentPath;
	readonly key: string;
	readonly generation: number;
	readonly incarnation: string;
	currentSession?: BorrowedAgentSession;
	currentCapabilities: SubagentCapabilities;
	active: boolean;
	readonly listeners: Set<(event: SubagentLeaseEvent) => void>;
};

type UnknownRecord = Record<string, unknown>;

const EMPTY_CAPABILITIES: SubagentCapabilities = Object.freeze({});
const DEFAULT_HISTORY_LIMIT = 256;

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathKey(path: AgentPath): string {
	return JSON.stringify(path);
}

function copyPath(path: AgentPath): AgentPath {
	return Object.freeze([...path]);
}

function isPathPrefix(prefix: AgentPath, path: AgentPath): boolean {
	return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cloneUsage(value: AgentUsage | undefined): SubagentUsage {
	const usage = value ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
	const costBreakdown = usage.costBreakdown;
	return Object.freeze({
		input: finiteNumber(usage.input),
		output: finiteNumber(usage.output),
		cacheRead: finiteNumber(usage.cacheRead),
		cacheWrite: finiteNumber(usage.cacheWrite),
		cost: finiteNumber(usage.cost),
		turns: finiteNumber(usage.turns),
		...(costBreakdown
			? {
					costBreakdown: Object.freeze({
						input: finiteNumber(costBreakdown.input),
						output: finiteNumber(costBreakdown.output),
						cacheRead: finiteNumber(costBreakdown.cacheRead),
						cacheWrite: finiteNumber(costBreakdown.cacheWrite),
					}),
				}
			: {}),
	});
}

function contextFill(lastTurnInput: unknown, contextWindow: unknown): number | undefined {
	const input = finiteNumber(lastTurnInput);
	const window = finiteNumber(contextWindow);
	if (window <= 0) return undefined;
	return Math.max(0, Math.min(100, Math.round((input / window) * 100)));
}

function validPath(value: unknown): value is AgentPath {
	return Array.isArray(value)
		&& value.every((part) => typeof part === "string" && part.length > 0);
}

function cloneRefs(refs: readonly PiEventRef[] | undefined): readonly PiEventRef[] {
	return Object.freeze((refs ?? []).map((ref) => Object.freeze({ ...ref })));
}

function cloneNode(node: ProviderNode): ProviderNode {
	return Object.freeze({
		...node,
		path: copyPath(node.path),
		channels: Object.freeze([...node.channels]),
		waitingFor: Object.freeze(node.waitingFor.map((target) => copyPath(target))),
		pendingCorrelations: Object.freeze([...node.pendingCorrelations]),
		usage: cloneUsage(node.usage),
	});
}

function cloneSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
	return Object.freeze({
		cursor: Object.freeze({ ...snapshot.cursor }),
		nodes: Object.freeze(snapshot.nodes.map((node) => cloneNode(node))),
	});
}

function sourceRecord(record: SubagentLifecycleRecord): UnknownRecord {
	const data = isRecord(record.data) ? record.data : {};
	return isRecord(data.source) ? data.source : {};
}

function statusRecord(record: SubagentLifecycleRecord): UnknownRecord {
	const data = isRecord(record.data) ? record.data : {};
	return isRecord(data.status) ? data.status : {};
}

function sourceChannels(source: UnknownRecord): readonly string[] {
	return Array.isArray(source.channels)
		? Object.freeze(source.channels.filter((channel): channel is string => typeof channel === "string"))
		: Object.freeze([]);
}

function sourceUsage(status: UnknownRecord): SubagentUsage {
	return cloneUsage(isRecord(status.usage) ? status.usage as AgentUsage : undefined);
}

function nodeFromLifecycle(
	record: SubagentLifecycleRecord,
	incarnation: string,
): ProviderNode {
	const source = sourceRecord(record);
	const status = statusRecord(record);
	const sessionId = record.sessionId ?? asString(source.sessionId) ?? "unknown";
	const task = asString(source.task);
	const persona = asString(source.personaName) ?? asString(source.agent);
	const personaIcon = asString(source.personaIcon);
	const model = asString(status.model);
	const lastOutput = asString(status.lastOutput);
	return cloneNode({
		path: copyPath(record.path),
		incarnation,
		sessionId,
		...(task !== undefined ? { task } : {}),
		...(persona !== undefined ? { persona } : {}),
		...(personaIcon !== undefined ? { personaIcon } : {}),
		...(model !== undefined ? { model } : {}),
		state: "idle",
		usage: sourceUsage(status),
		...(contextFill(status.lastTurnInput, undefined) !== undefined
			? { contextFill: contextFill(status.lastTurnInput, undefined) }
			: {}),
		channels: sourceChannels(source),
		waitingFor: Object.freeze([]),
		pendingCorrelations: Object.freeze([]),
		hasSubgroup: false,
		...(lastOutput !== undefined ? { lastOutput } : {}),
	});
}

function lifecycleData(record: SubagentLifecycleRecord): SubagentLifecycleData {
	const data = isRecord(record.data) ? { ...record.data } : {};
	delete data.source;
	delete data.snapshot;
	delete data.status;
	const operation = record.kind === "resurrect"
		? "resurrect"
		: record.kind === "teardown"
			? "teardown"
			: record.kind === "interrupt"
				? "interrupt"
				: undefined;
	return {
		...data,
		...(operation !== undefined ? { operation } : {}),
		path: copyPath(record.path),
		...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
	};
}

function eventCursor(epoch: string, sequence: number): FeedCursor {
	return Object.freeze({ epoch, sequence });
}

/** Provider feed, hierarchy projection, and borrowed runtime lease owner. */
export function createSubagentProvider(options: SubagentProviderOptions): SubagentProvider & {
	/** Stop accepting facts and release provider subscriptions. */
	shutdown(): void;
} {
	const epoch = randomUUID();
	const historyLimit = Number.isInteger(options.historyLimit) && (options.historyLimit ?? 0) > 0
		? options.historyLimit!
		: DEFAULT_HISTORY_LIMIT;
	let sequence = 0;
	let eventCounter = 0;
	let leaseGeneration = 0;
	let incarnationCounter = 0;
	let closed = false;
	const history: SubagentEvent[] = [];
	const listeners = new Set<(event: SubagentEvent) => void>();
	const liveNodes = new Map<string, ProviderNode>();
	const liveIdentity = new Map<string, NodeIdentity>();
	const retiredIncarnations = new Map<string, Set<string>>();
	const leases = new Map<string, Set<LeaseRecord>>();
	const historicalNodes = new Map<string, ProviderNode>();
	const historicalIdentity = new Map<string, NodeIdentity>();
	const historicalRetired = new Map<string, Set<string>>();
	let registryUnsubscribe: (() => void) | undefined;
	let semanticUnsubscribe: (() => void) | undefined;

	function currentCursor(): FeedCursor {
		return eventCursor(epoch, sequence);
	}

	function nextIncarnation(
		path: AgentPath,
		candidate: string | undefined,
		identities: Map<string, NodeIdentity>,
		retired: Map<string, Set<string>>,
	): NodeIdentity {
		const key = pathKey(path);
		const prior = identities.get(key);
		if (prior && (candidate === undefined || candidate === prior.incarnation)) return prior;
		const retiredForPath = retired.get(key) ?? new Set<string>();
		let incarnation = candidate;
		if (incarnation === undefined || retiredForPath.has(incarnation)) {
			incarnation = candidate ?? `incarnation-${++incarnationCounter}`;
			while (retiredForPath.has(incarnation)) incarnation = `${incarnation}-${++incarnationCounter}`;
		}
		const identity = Object.freeze({ incarnation, explicit: candidate !== undefined });
		identities.set(key, identity);
		return identity;
	}

	function retireIdentity(path: AgentPath, identity: NodeIdentity | undefined): void {
		if (!identity) return;
		const key = pathKey(path);
		const retired = retiredIncarnations.get(key) ?? new Set<string>();
		retired.add(identity.incarnation);
		retiredIncarnations.set(key, retired);
	}

	function projectWaiting(path: AgentPath, operational: AgentNodeSnapshot["operational"]): readonly AgentPath[] {
		const resolved: AgentPath[] = [];
		for (const target of operational.waitingForPaths ?? []) {
			if (validPath(target)) resolved.push(copyPath(target));
		}
		const known = resolved.length;
		for (let index = known; index < operational.waitingFor.length; index++) {
			const localId = operational.waitingFor[index];
			if (typeof localId !== "string" || localId.length === 0) continue;
			const target = localId === "parent"
				? path.slice(0, -1)
				: [...path.slice(0, -1), localId];
			resolved.push(copyPath(target));
		}
		return Object.freeze(resolved);
	}

	function projectNode(snapshot: AgentNodeSnapshot, identity: NodeIdentity): ProviderNode {
		const operational = snapshot.operational;
		const descendants = (() => {
			try {
				return options.registry.listDescendants(snapshot.path).length > 0;
			} catch {
				return false;
			}
		})();
		const persona = asString(snapshot.persona);
		const personaIcon = asString(snapshot.personaIcon);
		const model = asString(operational.model);
		const thinkingLevel = asString(operational.thinkingLevel);
		const activity = asString(operational.lastActivity);
		const lastOutput = asString(operational.lastOutput);
		const lastError = asString(operational.lastError);
		const fill = contextFill(operational.lastTurnInput, operational.contextWindow);
		return cloneNode({
			path: copyPath(snapshot.path),
			incarnation: identity.incarnation,
			sessionId: snapshot.sessionId,
			...(snapshot.task !== undefined ? { task: snapshot.task } : {}),
			...(persona !== undefined ? { persona } : {}),
			...(personaIcon !== undefined ? { personaIcon } : {}),
			...(model !== undefined ? { model } : {}),
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
			state: operational.state,
			...(activity !== undefined ? { activity } : {}),
			usage: cloneUsage(operational.usage),
			...(fill !== undefined ? { contextFill: fill } : {}),
			channels: Object.freeze([...snapshot.channels]),
			waitingFor: projectWaiting(snapshot.path, operational),
			pendingCorrelations: Object.freeze([...operational.pendingCorrelations]),
			hasSubgroup: Boolean(operational.hasSubgroup || descendants),
			...(lastOutput !== undefined ? { lastOutput } : {}),
			...(lastError !== undefined ? { lastError } : {}),
		});
	}

	function setInitialNode(snapshot: AgentNodeSnapshot): void {
		if (snapshot.path.length === 0 || snapshot.ownership !== "registry") return;
		const key = pathKey(snapshot.path);
		const identity = nextIncarnation(
			snapshot.path,
			asString(snapshot.incarnation),
			liveIdentity,
			retiredIncarnations,
		);
		liveNodes.set(key, projectNode(snapshot, identity));
	}

	function refreshInitialNodes(): void {
		let nodes: readonly AgentNodeSnapshot[] = [];
		try {
			nodes = options.registry.listDescendants([]);
		} catch {
			nodes = [];
		}
		for (const snapshot of nodes) setInitialNode(snapshot);
	}

	function appendEvent(
		base: Omit<SubagentEvent, "cursor">,
		deliver = true,
	): SubagentEvent {
		const event = Object.freeze({
			...base,
			path: copyPath(base.path),
			relatedPiEvents: cloneRefs(base.relatedPiEvents),
			cursor: eventCursor(epoch, ++sequence),
		}) as SubagentEvent;
		history.push(event);
		while (history.length > historyLimit) history.shift();
		if (deliver && !closed) {
			for (const listener of Array.from(listeners)) {
				try {
					listener(event);
				} catch {
					// One observer cannot interrupt provider delivery.
				}
			}
		}
		return event;
	}

	function generatedEventId(kind: SubagentEventKind, path: AgentPath): string {
		return `provider:${kind}:${pathKey(path)}:${++eventCounter}`;
	}

	function appendRegistryEvent(event: RegistryEvent): void {
		if (closed) return;
		if (event.node.path.length === 0) return;
		const key = pathKey(event.node.path);
		if (event.type === "node_added") {
			const previous = liveNodes.get(key);
			if (previous) {
				const identity = liveIdentity.get(key)!;
				const next = projectNode(event.node, identity);
				liveNodes.set(key, next);
				appendEvent({
					eventId: generatedEventId("node_updated", next.path),
					path: next.path,
					relatedPiEvents: [],
					kind: "node_updated",
					data: next,
				});
				return;
			}
			const identity = nextIncarnation(
				event.node.path,
				asString(event.node.incarnation),
				liveIdentity,
				retiredIncarnations,
			);
			const next = projectNode(event.node, identity);
			liveNodes.set(key, next);
			appendEvent({
				eventId: generatedEventId("node_added", next.path),
				path: next.path,
				relatedPiEvents: [],
				kind: "node_added",
				data: next,
			});
			return;
		}

		if (event.type === "node_updated") {
			const prior = liveNodes.get(key);
			const priorIdentity = liveIdentity.get(key);
			const incomingIncarnation = asString(event.node.incarnation);
			const identity = priorIdentity && incomingIncarnation === undefined
				? priorIdentity
				: nextIncarnation(event.node.path, incomingIncarnation, liveIdentity, retiredIncarnations);
			if (priorIdentity && identity.incarnation !== priorIdentity.incarnation) {
				closeLeases(event.node.path, "removed");
				retireIdentity(event.node.path, priorIdentity);
			}
			const next = projectNode(event.node, identity);
			liveNodes.set(key, next);
			appendEvent({
				eventId: generatedEventId("node_updated", next.path),
				path: next.path,
				relatedPiEvents: [],
				kind: "node_updated",
				data: next,
			});
			const runtimeChanged = prior?.sessionId !== next.sessionId;
			if (runtimeChanged) rebindLeases(next.path, false);
			return;
		}

		if (event.type === "runtime_replaced") {
			const prior = liveNodes.get(key);
			const priorIdentity = liveIdentity.get(key)
				?? nextIncarnation(event.node.path, asString(event.node.incarnation), liveIdentity, retiredIncarnations);
			const next = projectNode(event.node, priorIdentity);
			liveNodes.set(key, next);
			appendEvent({
				eventId: generatedEventId("runtime_replaced", next.path),
				path: next.path,
				relatedPiEvents: [],
				kind: "runtime_replaced",
				data: { oldSessionId: event.oldSessionId, newSessionId: event.newSessionId },
			});
			rebindLeases(next.path, true);
			return;
		}

		const identity = liveIdentity.get(key);
		const node = liveNodes.get(key) ?? projectNode(event.node, identity ?? nextIncarnation(event.node.path, asString(event.node.incarnation), liveIdentity, retiredIncarnations));
		appendEvent({
			eventId: generatedEventId("node_removed", node.path),
			path: node.path,
			relatedPiEvents: [],
			kind: "node_removed",
			data: { node, reason: "removed" },
		});
		for (const [candidateKey, candidate] of Array.from(liveNodes.entries())) {
			if (!isPathPrefix(node.path, candidate.path)) continue;
			const candidateIdentity = liveIdentity.get(candidateKey);
			closeLeases(candidate.path, "removed");
			retireIdentity(candidate.path, candidateIdentity);
			liveNodes.delete(candidateKey);
			liveIdentity.delete(candidateKey);
		}
	}

	function historicalIdentityFor(record: SubagentLifecycleRecord, add: boolean): NodeIdentity {
		const key = pathKey(record.path);
		const prior = historicalIdentity.get(key);
		if (prior && !add) return prior;
		if (prior && add && historicalNodes.has(key)) return prior;
		const source = sourceRecord(record);
		const candidate = asString(source.incarnation);
		const retired = historicalRetired.get(key) ?? new Set<string>();
		let incarnation = candidate ?? `lifecycle-${historicalIdentity.size + 1}`;
		if (retired.has(incarnation)) incarnation = `${incarnation}-${historicalIdentity.size + 1}`;
		const identity = Object.freeze({ incarnation, explicit: candidate !== undefined });
		historicalIdentity.set(key, identity);
		return identity;
	}

	function appendLifecycleRecord(record: SubagentLifecycleRecord): void {
		if (!validPath(record.path)) return;
		const key = pathKey(record.path);
		if (record.kind === "node_added" || record.kind === "node_updated" || record.kind === "resurrect") {
			const add = record.kind !== "node_updated";
			const identity = historicalIdentityFor(record, add);
			const node = nodeFromLifecycle(record, identity.incarnation);
			historicalNodes.set(key, node);
			if (record.kind === "resurrect") {
				appendEvent({
					eventId: record.recordId,
					path: node.path,
					relatedPiEvents: [],
					kind: "resurrect",
					data: lifecycleData(record),
				});
			} else {
				appendEvent({
					eventId: record.recordId,
					path: node.path,
					relatedPiEvents: [],
					kind: record.kind,
					data: node,
				});
			}
			return;
		}
		if (record.kind === "node_removed") {
			const identity = historicalIdentity.get(key) ?? historicalIdentityFor(record, false);
			const node = historicalNodes.get(key) ?? nodeFromLifecycle(record, identity.incarnation);
			const data = isRecord(record.data) ? record.data : {};
			appendEvent({
				eventId: record.recordId,
				path: node.path,
				relatedPiEvents: [],
				kind: "node_removed",
				data: { node, reason: data.stale === true ? "stale" : "removed" },
			});
			if (data.stale !== true) {
				historicalNodes.delete(key);
				historicalIdentity.delete(key);
				const retired = historicalRetired.get(key) ?? new Set<string>();
				retired.add(identity.incarnation);
				historicalRetired.set(key, retired);
			}
			return;
		}
		appendEvent({
			eventId: record.recordId,
			path: copyPath(record.path),
			relatedPiEvents: [],
			kind: record.kind,
			data: lifecycleData(record) as SubagentEvent["data"],
		});
	}

	function findRegistered(path: AgentPath): RegisteredAgentNode {
		if (path.length === 0) throw new Error("The root session is not a child view");
		let node: ReturnType<AgentSessionRegistry["get"]>;
		try {
			node = options.registry.get(path);
		} catch {
			node = undefined;
		}
		if (!node || node.snapshot.path.length === 0 || node.snapshot.ownership !== "registry" || !("session" in node)) {
			throw new Error(`Unknown subagent path ${JSON.stringify(path)}`);
		}
		return node as RegisteredAgentNode;
	}

	function borrow(node: RegisteredAgentNode): { session: BorrowedAgentSession; capabilities: SubagentCapabilities } {
		let session: AgentSession;
		try {
			session = node.session.session;
		} catch (error) {
			throw new Error(`Subagent runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!session) throw new Error("Subagent runtime is unavailable");
		let capabilities: SubagentCapabilities = EMPTY_CAPABILITIES;
		try {
			const candidate = (node.session as ManagedChildSession & { capabilities?: SubagentCapabilities }).capabilities;
			if (candidate) capabilities = candidate;
		} catch (error) {
			throw new Error(`Subagent capabilities are unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		return {
			session: session as unknown as BorrowedAgentSession,
			capabilities,
		};
	}

	function notifyLease(record: LeaseRecord, event: SubagentLeaseEvent): void {
		for (const listener of Array.from(record.listeners)) {
			try {
				listener(event);
			} catch {
				// One view observer cannot interrupt provider lifecycle.
			}
		}
	}

	function closeLease(record: LeaseRecord, reason: "removed" | "unavailable"): void {
		if (!record.active) return;
		record.active = false;
		record.currentSession = undefined;
		const pathLeases = leases.get(record.key);
		pathLeases?.delete(record);
		if (pathLeases && pathLeases.size === 0) leases.delete(record.key);
		notifyLease(record, { kind: "closed", reason });
		record.listeners.clear();
	}

	function closeLeases(path: AgentPath, reason: "removed" | "unavailable"): void {
		for (const [key, records] of Array.from(leases.entries())) {
			const candidate = JSON.parse(key) as AgentPath;
			if (!isPathPrefix(path, candidate)) continue;
			for (const record of Array.from(records)) closeLease(record, reason);
		}
	}

	function rebindLeases(path: AgentPath, force: boolean): void {
		const key = pathKey(path);
		const records = leases.get(key);
		if (!records || records.size === 0) return;
		let registered: RegisteredAgentNode;
		try {
			registered = findRegistered(path);
		} catch {
			for (const record of Array.from(records)) closeLease(record, "unavailable");
			return;
		}
		let borrowed: { session: BorrowedAgentSession; capabilities: SubagentCapabilities };
		try {
			borrowed = borrow(registered);
		} catch {
			for (const record of Array.from(records)) closeLease(record, "unavailable");
			return;
		}
		for (const record of Array.from(records)) {
			if (!record.active) continue;
			if (!force && record.currentSession === borrowed.session) continue;
			record.currentSession = borrowed.session;
			record.currentCapabilities = borrowed.capabilities;
			const event: SubagentLeaseEvent = borrowed.capabilities === EMPTY_CAPABILITIES
				? { kind: "rebound", session: borrowed.session }
				: { kind: "rebound", session: borrowed.session, capabilities: borrowed.capabilities };
			notifyLease(record, event);
		}
	}

	function controlIdentity(path: AgentPath): { node: ProviderNode; explicit: boolean } {
		if (path.length === 0) throw new Error("The root session is not a child view");
		const node = liveNodes.get(pathKey(path));
		if (!node) throw new Error(`Unknown subagent path ${JSON.stringify(path)}`);
		return { node, explicit: liveIdentity.get(pathKey(path))?.explicit === true };
	}

	function assertIncarnation(path: AgentPath, incarnation: string): ProviderNode {
		const { node, explicit } = controlIdentity(path);
		if (explicit && node.incarnation !== incarnation) {
			throw new Error(`Stale subagent incarnation for ${JSON.stringify(path)}`);
		}
		return node;
	}

	function subscribe(listener: (event: SubagentEvent) => void): () => void {
		if (closed) return () => {};
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	function snapshot(): SubagentSnapshot {
		return cloneSnapshot({
			cursor: currentCursor(),
			nodes: Object.freeze(Array.from(liveNodes.values()).map((node) => cloneNode(node))),
		});
	}

	function replay(after?: FeedCursor): ReplayResult {
		const cursor = currentCursor();
		if (after === undefined) {
			return Object.freeze({ kind: "events", cursor, events: Object.freeze([...history]) });
		}
		if (after.epoch !== epoch) return { kind: "snapshot_required", reason: "epoch_changed" };
		if (!Number.isInteger(after.sequence) || after.sequence < 0 || after.sequence > sequence) {
			return { kind: "snapshot_required", reason: "history_unavailable" };
		}
		if (after.sequence === sequence) {
			return Object.freeze({ kind: "events", cursor, events: Object.freeze([]) });
		}
		const first = history[0]?.cursor.sequence;
		if (first === undefined || after.sequence < first - 1) {
			return { kind: "snapshot_required", reason: "history_unavailable" };
		}
		const events = history.filter((event) => event.cursor.sequence > after.sequence);
		const expected = sequence - after.sequence;
		if (events.length !== expected || (events[0]?.cursor.sequence ?? after.sequence + 1) !== after.sequence + 1) {
			return { kind: "snapshot_required", reason: "history_unavailable" };
		}
		return Object.freeze({ kind: "events", cursor, events: Object.freeze(events) });
	}

	async function acquire(path: AgentPath): Promise<SubagentLease> {
		if (closed) throw new Error("Subagent provider is shut down");
		const registered = findRegistered(path);
		const key = pathKey(path);
		const identity = liveIdentity.get(key) ?? nextIncarnation(path, asString(registered.snapshot.incarnation), liveIdentity, retiredIncarnations);
		const node = projectNode(registered.snapshot, identity);
		liveNodes.set(key, node);
		const borrowed = borrow(registered);
		const record: LeaseRecord = {
			path: copyPath(path),
			key,
			generation: ++leaseGeneration,
			incarnation: identity.incarnation,
			currentSession: borrowed.session,
			currentCapabilities: borrowed.capabilities,
			active: true,
			listeners: new Set(),
		};
		const pathLeases = leases.get(key) ?? new Set<LeaseRecord>();
		pathLeases.add(record);
		leases.set(key, pathLeases);
		const lease: SubagentLease = {
			path: record.path,
			get session(): BorrowedAgentSession {
				if (!record.active || record.currentSession === undefined) throw new Error("Subagent lease is closed");
				return record.currentSession;
			},
			get capabilities(): SubagentCapabilities {
				return record.currentCapabilities;
			},
			subscribe(listener) {
				if (!record.active) return () => {};
				record.listeners.add(listener);
				return () => record.listeners.delete(listener);
			},
			release: async () => {
				if (!record.active) return;
				record.active = false;
				record.currentSession = undefined;
				const current = leases.get(record.key);
				current?.delete(record);
				if (current && current.size === 0) leases.delete(record.key);
				record.listeners.clear();
			},
		};
		return lease;
	}

	async function teardown(path: AgentPath, incarnation: string): Promise<SubagentTeardownResult> {
		assertIncarnation(path, incarnation);
		if (closed) throw new Error("Subagent provider is shut down");
		const result = await options.ownerControl.teardown(copyPath(path), incarnation);
		return {
			...result,
			path: copyPath(result.path ?? path),
			...(result.incarnation === undefined ? { incarnation } : {}),
		};
	}

	async function stop(request: SubagentStopRequest): Promise<void> {
		const node = assertIncarnation(request.path, request.incarnation);
		if (closed) throw new Error("Subagent provider is shut down");
		if (node.sessionId !== request.expectedSessionId) {
			throw new Error(`Stale subagent runtime for ${JSON.stringify(request.path)}`);
		}
		await options.ownerControl.stop({
			...request,
			path: copyPath(request.path),
		});
	}

	async function resurrect(request: SubagentResurrectRequest): Promise<SubagentResurrectResult> {
		if (closed) throw new Error("Subagent provider is shut down");
		if (!validPath(request.parentPath)) {
			if (request.parentPath.length !== 0) throw new Error("Invalid resurrection parent path");
		}
		if (request.parentPath.length > 0) {
			const parent = options.registry.get(request.parentPath);
			if (!parent || parent.snapshot.ownership !== "registry") {
				throw new Error(`Unknown resurrection parent path ${JSON.stringify(request.parentPath)}`);
			}
		}
		if (typeof request.localId !== "string" || request.localId.length === 0 || request.localId === "parent") {
			throw new Error("Invalid resurrection local id");
		}
		return options.ownerControl.resurrect({
			...request,
			parentPath: copyPath(request.parentPath),
			channels: Object.freeze([...request.channels]),
		});
	}

	function shutdown(): void {
		if (closed) return;
		closed = true;
		registryUnsubscribe?.();
		semanticUnsubscribe?.();
		registryUnsubscribe = undefined;
		semanticUnsubscribe = undefined;
		for (const records of Array.from(leases.values())) {
			for (const record of Array.from(records)) closeLease(record, "unavailable");
		}
		leases.clear();
		listeners.clear();
	}

	refreshInitialNodes();
	let lifecycleReader = options.lifecycle;
	if (!lifecycleReader && options.parentSessionFile) {
		lifecycleReader = createSubagentLifecycleReader(getPersistencePaths(options.parentSessionFile));
	}
	if (lifecycleReader) {
		let records: readonly SubagentLifecycleRecord[] = [];
		try {
			records = lifecycleReader.read();
		} catch {
			records = [];
		}
		for (const record of records) appendLifecycleRecord(record);
	}

	registryUnsubscribe = options.registry.subscribe(appendRegistryEvent);
	if (options.semanticEvents) semanticUnsubscribe = options.semanticEvents.subscribe((fact) => {
		if (closed) return;
		const semantic = createSemanticEvent({
			...fact,
			path: copyPath(fact.path),
			relatedPiEvents: cloneRefs(fact.relatedPiEvents),
		});
		appendEvent(semantic as Omit<SubagentEvent, "cursor">);
	});

	return {
		subscribe,
		snapshot,
		replay,
		acquire,
		teardown,
		stop,
		resurrect,
		shutdown,
	};
}
