/**
 * Immediate-child orchestration over registry-owned SDK sessions.
 *
 * This manager owns parent-local topology, routing, persistence, and status
 * projection policy. The shared registry owns every live child runtime and
 * canonical operational snapshot.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentSpec,
	type ForkAgentSpec,
	isValidCwd,
	resolvePersonaSkillPaths,
} from "./agents.js";
import { childAgentPath, qualifiedAgentId, type AgentPath } from "./agent-path.js";
import {
	addCostBreakdown,
	costBreakdownFromUsage,
	subtractCostBreakdown,
	type AgentNodeSnapshot,
	type AgentOperationalSnapshot,
	type AgentSessionRegistry,
	type AgentUsage as RegistryAgentUsage,
	type CreateAgentNodeRequest,
} from "./agent-session-registry.js";
import { resolveChildToolPolicy } from "./child-tool-policy.js";
import type { PersonaPayload } from "./child-session-marker.js";
import type {
	SubagentManagerControl,
	SubagentResurrectRequest,
	SubagentResurrectResult,
	SubagentStopRequest,
	SubagentTeardownResult,
} from "./provider.js";
import { loadWorkspacePersona, type PersonaDeclaration } from "../persona-workspaces/declaration.ts";
import {
	appendAgentAdded,
	appendAgentRemoved,
	ensurePersistence,
	findAgentRecordBySessionId,
	getPersistencePaths,
	loadPersistedAgents,
	pruneInvalidPersistedAgents,
	type PersistedAgentRecord,
	type PersistencePaths,
} from "./persistence.js";
import { type AgentChannelSpec } from "./channels.js";
import {
	MessageRouter,
	type MessagePort,
	type RoutedMessage,
	type RoutedMessagePhase,
} from "./message-router.js";
import { parseSessionSnapshot } from "./session-snapshot.js";
import { formatTokenCount } from "./format.js";
import { stripThinkingSuffix } from "./model-tiers.js";
import {
	serializeAgentMessage,
	serializeAgentTorndown,
	serializeGroupTorndown,
	serializeSubagentIdentity,
	type ActiveAgentsCompleteData,
	type AgentCompleteData,
} from "./messages.js";

/**
 * Capability fields of one persona file — a workspace declaration or a
 * discovered spawned definition. Absent fields fall through to the ordinary
 * construction baseline; a discarded file's values never survive.
 */
export type PersonaCapabilities = {
	/** Winning persona presentation name. */
	name: string;
	/** Winning persona flat icon text, if declared. */
	icon?: string;
	/** Raw model reference (tier name or model id, `":<level>"` suffix allowed). A pin: it outranks an explicit `model` spawn argument. */
	model?: string;
	/** Tool allowlist; absent selects the ordinary child/fork baseline. */
	tools?: string[];
	/** Skill names for `resolvePersonaSkillPaths`; absent leaves ordinary discovery intact. */
	skills?: string[];
};

/**
 * Select the one active persona file for a child construction, wholesale: a
 * workspace declaration at the child's effective cwd wins outright over the
 * discovered spawned definition — the loser is discarded entire and its fields
 * are never merged into the winner. With neither, nothing binds.
 */
export function selectActivePersona(
	workspace: PersonaDeclaration | undefined,
	spawned: AgentConfig | undefined,
): PersonaCapabilities | undefined {
	const active = workspace ?? spawned;
	if (active === undefined) return undefined;
	return {
		name: active.name,
		...(active.icon !== undefined ? { icon: active.icon } : {}),
		model: active.model,
		tools: active.tools,
		skills: active.skills,
	};
}

/**
 * The active persona capabilities for a child constructed at `effectiveCwd`:
 * its workspace declaration (`<effectiveCwd>/AGENTS.md`, strict cwd-only read),
 * else the discovered spawned definition. I/O edge around the pure
 * `selectActivePersona`.
 */
export function loadActivePersona(
	effectiveCwd: string,
	spawned: AgentConfig | undefined,
): PersonaCapabilities | undefined {
	return selectActivePersona(loadWorkspacePersona(effectiveCwd), spawned);
}

/**
 * `idle` and `errored` are both settled-with-a-live-session: a later send
 * revives either one. `errored` only records that the last run ended badly.
 * `dead` is the single terminal state — the child runtime is gone and the id
 * is unreachable until teardown + resurrect replaces it.
 */
export type AgentState = "running" | "idle" | "waiting" | "errored" | "dead";

/** States in which no further work is in flight for an agent. */
export function isSettledState(state: AgentState): boolean {
	return state === "idle" || state === "errored" || state === "dead";
}

/**
 * Result of an interrupt: whether the child reached idle before the caller
 * stopped waiting. The abort is delivered either way.
 */
export type InterruptOutcome = "settled" | "pending";

/**
 * Native settlement metadata that does not change the five registry states.
 * An aborted child is still projected as `idle`, but its completion is a
 * stopped outcome so callers do not receive an unsolicited idle notification.
 */
export type AgentCompletionOutcome = Readonly<{
	aborted?: boolean;
}>;

/** How long an interrupt waits for the child to reach idle. */
export const INTERRUPT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Await a settle promise without adopting its liveness. Returns "pending" once
 * the timeout elapses or the caller's own signal aborts; the underlying promise
 * is left to finish on its own and its rejection is absorbed, since the abort
 * has already been delivered and no caller remains to hear about it.
 */
async function boundedSettle(
	settled: Promise<void>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<InterruptOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race<InterruptOutcome>([
			settled.then(() => "settled" as const),
			new Promise<InterruptOutcome>((resolve) => {
				timer = setTimeout(() => resolve("pending"), timeoutMs);
				if (!signal) return;
				if (signal.aborted) {
					resolve("pending");
					return;
				}
				onAbort = () => resolve("pending");
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		settled.catch(() => {});
	}
}

/** Cumulative token/cost accounting for one agent. */
export type AgentUsage = RegistryAgentUsage;

export interface AgentStatus {
	id: string;
	/** Stable public-path incarnation, changed on removal and path reuse. */
	incarnation: string;
	state: AgentState;
	agentDef?: string;
	/** Winning persona metadata, distinct from the requested definition key. */
	persona?: string;
	personaIcon?: string;
	task: string;
	channels: string[];
	lastActivity?: string;
	usage: AgentUsage;
	model?: string;
	/** Pi thinking level used for the current model. */
	thinkingLevel?: string;
	lastOutput?: string;
	/** Error from the last errored run, surfaced in idle notifications. */
	lastError?: string;
	pendingCorrelations: string[];
	lastTurnInput: number;
	contextWindow?: number;
	hasSubgroup: boolean;
	waitingFor: string[];
	/** Root-relative waiting targets for provider projections. */
	waitingForPaths?: AgentPath[];
}

/**
 * Parent-local data that is not represented by a registry snapshot. During
 * construction only, `provisionalOperational` carries SDK events that arrive
 * before the registry batch becomes visible; it is discarded on commit.
 */
interface AgentEntry {
	readonly path: AgentPath;
	readonly id: string;
	readonly agentDef?: string;
	readonly persona?: string;
	readonly personaIcon?: string;
	readonly task: string;
	readonly channels: string[];
	readonly kind: AgentSpec["kind"];
	readonly cwd?: string;
	readonly forkTools?: string[];
	readonly forkSkillPaths?: string[];
	readonly port: MessagePort;
	readonly seenAssistantMessages: WeakSet<object>;
	/** Usage at entry creation: zero for spawns and resurrects, replayed usage for parent-session restores. Teardown deltas subtract it. */
	readonly usageBaseline: AgentUsage;
	completionNotified: boolean;
	pendingTerminalError?: string;
	completionPending: boolean;
	committed: boolean;
	provisionalOperational?: AgentOperationalSnapshot;
}

export interface SubagentManagerOptions {
	pi: ExtensionAPI;
	cwd: string;
	/** Shared per-root runtime registry; manager owns only its immediate orchestration. */
	registry: AgentSessionRegistry;
	/** Canonical path of the manager's owning node in the shared registry. */
	ownerPath: AgentPath;
	parentSessionFile?: string;
	resolveContextWindow: (modelId: string) => number | undefined;
	onUpdate: (mgr: SubagentManager) => void;
	onAgentStart?: (mgr: SubagentManager, agentId: string) => void;
	onAgentComplete: (
		mgr: SubagentManager,
		agentId: string,
		allDone: boolean,
		outcome?: AgentCompletionOutcome,
	) => boolean | void;
	onParentMessage: (port: MessagePort, xml: string, meta: { from?: string; correlationId?: string; responseExpected: boolean }) => void;
	onMessagePhase?: (event: RoutedMessagePhase) => void;
}

export class SubagentManager {
	private entries: AgentEntry[] = [];
	private readonly pendingEntries = new Set<AgentEntry>();
	private readonly router: MessageRouter;
	private readonly parentPort: MessagePort;
	private readonly opts: SubagentManagerOptions;
	private readonly correlationToTarget = new Map<string, { localId: string; path: AgentPath }>();
	/** Child paths stopped through the owner-control port. */
	private readonly stopRequested = new Set<string>();
	private sessionDir: string | null = null;
	private persistence: PersistencePaths | null = null;
	private restoring = false;
	private restoreAttempted = false;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(opts: SubagentManagerOptions) {
		this.opts = opts;
		this.router = new MessageRouter({
			onBlockingSendStart: (from, to, correlationId) => this.markAgentWaiting(from, correlationId, to),
			onBlockingSendEnd: (from, correlationId) => this.clearAgentWaiting(from, correlationId),
			onMessagePhase: (event) => this.opts.onMessagePhase?.(event),
		});
		this.parentPort = this.router.connect("parent");
		this.parentPort.subscribe((message) => this.deliverParentMessage(message));
	}

	getAgentStatuses(): AgentStatus[] {
		return this.opts.registry.listChildren(this.opts.ownerPath).map(projectStatus);
	}

	/**
	 * Statuses for this manager's entire live subtree, flattened depth-first with
	 * path-qualified ids (`worker/scout`). Presentation only — tools, routing and
	 * notifications stay scoped to immediate children via `getAgentStatuses`.
	 */
	getDisplayStatuses(): AgentStatus[] {
		const owner = this.opts.ownerPath;
		const listDescendants = this.opts.registry.listDescendants;
		const snapshots = typeof listDescendants === "function"
			? listDescendants.call(this.opts.registry, owner)
			: this.opts.registry.listChildren(owner);
		return snapshots.map((snapshot) => ({
			...projectStatus(snapshot),
			id: qualifiedAgentId(owner, snapshot.path) || snapshot.localId || "",
		}));
	}

	getAgentStatus(agentId: string): AgentStatus | undefined {
		const snapshot = this.opts.registry
			.listChildren(this.opts.ownerPath)
			.find((candidate) => candidate.localId === agentId);
		return snapshot ? projectStatus(snapshot) : undefined;
	}

	/** Control seam used by the root owner to route guarded mutations. */
	createControl(
		resurrect: (request: SubagentResurrectRequest) => Promise<SubagentResurrectResult>,
	): SubagentManagerControl {
		return {
			teardown: (localId, incarnation) => this.teardownGuarded(localId, incarnation),
			stop: (request) => this.stopGuarded(request),
			resurrect,
		};
	}

	/** Child session file id for resurrect, or undefined for an unknown agent. */
	getAgentPath(agentId: string): AgentPath | undefined {
		const path = childAgentPath(this.opts.ownerPath, agentId);
		return this.opts.registry.getSnapshot(path) ? path : undefined;
	}

	getSessionId(agentId: string): string | undefined {
		return this.opts.registry
			.listChildren(this.opts.ownerPath)
			.find((candidate) => candidate.localId === agentId)?.sessionId;
	}

	/** Mark a held completion after its notification actually leaves the gate. */
	markCompletionDelivered(agentId: string): void {
		const entry = this.findEntry(agentId);
		if (entry) entry.completionNotified = true;
	}

	/** Usage consumed since the entry was created, including its live subtree. */
	getUsageDelta(agentId: string): { delta: AgentUsage; baseline: AgentUsage } | undefined {
		const entry = this.findEntry(agentId);
		const targetPath = childAgentPath(this.opts.ownerPath, agentId);
		const target = this.opts.registry.getSnapshot(targetPath);
		if (!entry || !target) return undefined;

		const descendants = typeof this.opts.registry.listDescendants === "function"
			? this.opts.registry.listDescendants(targetPath)
			: [];
		let delta = zeroUsage();
		let baseline = zeroUsage();
		for (const snapshot of [target, ...descendants]) {
			const nodeBaseline = samePath(snapshot.path, targetPath)
			? entry.usageBaseline
			: this.opts.registry.getUsageBaseline?.(snapshot.path) ?? zeroUsage();
			delta = addUsage(delta, subtractUsage(snapshot.operational.usage, nodeBaseline));
			baseline = addUsage(baseline, nodeBaseline);
		}
		return { delta, baseline };
	}

	hasAgents(): boolean {
		return this.opts.registry.listChildren(this.opts.ownerPath).length > 0;
	}

	/** Parent endpoint for this manager's local routing namespace. */
	getParentPort(): MessagePort {
		return this.parentPort;
	}

	/**
	 * Agents blocked on a response from this parent, as recorded by the router.
	 * Read from the routing authority rather than projected agent status: the
	 * status projection is maintained through callbacks whose failures are
	 * swallowed, and a later child event can overwrite the `waiting` state.
	 */
	getBlockedSenders(): Array<{ from: string; correlationId: string }> {
		return this.router.pendingSendersTo("parent");
	}

	/**
	 * Abort the target agent's current operation (equivalent to pressing Escape
	 * in the TUI). An already-settled child is deliberately a no-op for parity.
	 *
	 * The signal reaches the child immediately; settling is what may lag, since a
	 * tool that ignores its abort signal keeps the run alive for as long as it
	 * pleases. Waiting unbounded on that would hang the caller with no way out,
	 * so the wait is bounded and the outcome reported: "settled" when the child
	 * reached idle, "pending" when the abort was delivered but the run is still
	 * unwinding.
	 */
	async interrupt(agentId: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<InterruptOutcome> {
		return this.serializeMutation(() => this.interruptUnlocked(agentId, options));
	}

	/**
	 * Guarded child Stop entry point used by the root control port. Validation and
	 * the abort happen in the ordinary manager mutation queue, so a stale view
	 * cannot race a later path incarnation or call the borrowed runtime directly.
	 */
	async stopGuarded(request: SubagentStopRequest): Promise<void> {
		return this.serializeMutation(async () => {
			const childPath = childAgentPath(this.opts.ownerPath, request.path.at(-1) ?? "");
			if (!samePath(request.path, childPath)) throw new Error("Stale child stop path");
			const node = this.opts.registry.get(childPath);
			if (!node || node.snapshot.ownership !== "registry") throw new Error(`Unknown agent: "${request.path.at(-1) ?? ""}"`);
			if (node.snapshot.incarnation !== request.incarnation) throw new Error("Stale child incarnation");
			if (node.snapshot.sessionId !== request.expectedSessionId) throw new Error("Stale child session");
			const localId = request.path.at(-1) ?? "";
			if (isSettledState(node.snapshot.operational.state)) return;
			this.stopRequested.add(localId);
			try {
				await this.interruptUnlocked(localId);
			} catch (error) {
				this.stopRequested.delete(localId);
				throw error;
			}
		});
	}

	/**
	 * Guarded teardown entry point used by the root control port. The ordinary
	 * single-agent teardown owns lifecycle persistence, routing cleanup, reports,
	 * and subtree disposal; this method only adds path/incarnation validation.
	 */
	async teardownGuarded(localId: string, incarnation: string): Promise<SubagentTeardownResult> {
		return this.serializeMutation(async () => {
			const childPath = childAgentPath(this.opts.ownerPath, localId);
			const snapshot = this.opts.registry.getSnapshot(childPath);
			if (!snapshot || snapshot.ownership !== "registry") {
				return { path: childPath, removed: false, reason: "not_found" as const };
			}
			if (snapshot.incarnation !== incarnation) {
				return { path: childPath, removed: false, incarnation: snapshot.incarnation, sessionId: snapshot.sessionId, reason: "not_found" as const };
			}
			const sessionId = snapshot.sessionId;
			await this.teardownSingle(localId);
			return {
				path: childPath,
				removed: true,
				sessionId,
				incarnation,
				reason: "removed" as const,
			};
		});
	}

	private async interruptUnlocked(agentId: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<InterruptOutcome> {
		const childPath = childAgentPath(this.opts.ownerPath, agentId);
		const node = this.opts.registry.get(childPath);
		if (!node || node.snapshot.ownership !== "registry") {
			throw new Error(`Unknown agent: "${agentId}"`);
		}
		const state = node.snapshot.operational.state;
		if (state === "errored" || state === "dead") return "settled";
		return boundedSettle(node.session.abort(), options?.timeoutMs ?? INTERRUPT_SETTLE_TIMEOUT_MS, options?.signal);
	}

	/**
	 * Recompute the subgroup flag for a restored child from its own persistence
	 * log, without replicating the flag into this manager's records.
	 */
	private childHasLiveSubagents(childSessionFile: string): boolean {
		const loaded = loadPersistedAgents(childSessionFile);
		return loaded !== null && loaded.agents.length > 0;
	}

	async start(agents: AgentSpec[], agentConfigs: AgentConfig[]): Promise<string> {
		return this.serializeMutation(() => this.startUnlocked(agents, agentConfigs));
	}

	private async startUnlocked(agents: AgentSpec[], agentConfigs: AgentConfig[]): Promise<string> {
		if (agents.length === 0) {
			throw new Error("At least one agent is required");
		}
		this.assertSpawnableIds(agents);

		const firstStart = !this.hasAgents();
		let createdEntries: AgentEntry[] = [];

		try {
			this.ensureSessionDirectory();
			this.router.addAgents(
				agents.map(channelSpec),
				new Set(agents.filter((agent) => agent.kind === "fork").map((agent) => agent.id)),
			);

			const ports = new Map<string, MessagePort>();
			for (const spec of agents) {
				ports.set(spec.id, this.router.connect(spec.id));
			}

			const requests: CreateAgentNodeRequest[] = [];
			for (const spec of agents) {
				const entry = this.createEntry(spec, ports.get(spec.id)!, agents);
				createdEntries.push(entry);
				this.pendingEntries.add(entry);
				requests.push(this.createNodeRequest(spec, agentConfigs, entry, agents));
			}

			const nodes = await this.opts.registry.createChildren(this.opts.ownerPath, requests);

			for (let index = 0; index < createdEntries.length; index++) {
				const entry = createdEntries[index];
				const node = nodes[index];
				entry.committed = true;
				this.pendingEntries.delete(entry);
				this.entries.push(entry);

				const latest = entry.provisionalOperational;
				entry.provisionalOperational = undefined;
				if (latest && !operationalEqual(node.snapshot.operational, latest)) {
					this.opts.registry.updateOperational(entry.path, latest);
				}
			}

			if (!this.restoring) {
				this.ensurePersistence();
				for (const entry of createdEntries) {
					this.appendCurrentAgentRecord(entry, false);
				}
			}

			for (const entry of createdEntries) {
				if (entry.completionPending) {
					entry.completionPending = false;
					this.notifyCompletion(entry);
				}
			}

			if (!this.restoring) {
				for (const entry of createdEntries) {
					this.submitInitialTask(entry);
				}
			}

			this.opts.onUpdate(this);
			return spawnAcknowledgement(agents, this.restoring, firstStart);
		} catch (error) {
			const committedEntries = createdEntries.filter((entry) => entry.committed);
			if (committedEntries.length > 0) {
				this.entries = this.entries.filter((entry) => !committedEntries.includes(entry));
				await Promise.all(committedEntries.map((entry) => this.opts.registry.remove(entry.path)));
			}
			for (const entry of createdEntries) {
				this.pendingEntries.delete(entry);
			}
			for (const spec of agents) this.router.removeAgent(spec.id);
			throw error;
		}
	}

	async restoreFromPersistence(agentConfigs: AgentConfig[]): Promise<void> {
		return this.serializeMutation(() => this.restoreFromPersistenceUnlocked(agentConfigs));
	}

	private async restoreFromPersistenceUnlocked(agentConfigs: AgentConfig[]): Promise<void> {
		if (this.restoreAttempted || this.hasAgents()) return;
		this.restoreAttempted = true;
		const parentSessionFile = this.opts.parentSessionFile;
		if (!parentSessionFile) return;

		const persisted = loadPersistedAgents(parentSessionFile);
		if (!persisted || persisted.agents.length === 0) return;

		const survivors = pruneInvalidPersistedAgents(persisted.paths, persisted.agents, isValidCwd);
		if (survivors.length === 0) return;

		this.persistence = persisted.paths;
		this.sessionDir = persisted.paths.childSessionsDir;
		this.restoring = true;
		try {
			await this.startUnlocked(survivors.map((agent) => this.toRestoreSpec(agent, agentConfigs)), agentConfigs);
		} finally {
			this.restoring = false;
		}
	}

	async teardown(agentId?: string): Promise<{ report: string; empty: boolean }> {
		return this.serializeMutation(() => agentId === undefined ? this.teardownAll() : this.teardownSingle(agentId));
	}

	/**
	 * Dispose only this manager's immediate-child subtrees. Persistent lifecycle
	 * records remain untouched so a later session restore can reopen them.
	 */
	async softShutdown(): Promise<void> {
		return this.serializeMutation(() => this.softShutdownUnlocked());
	}

	private async softShutdownUnlocked(): Promise<void> {
		const entries = this.entries;
		this.entries = [];

		for (const entry of entries) {
			this.stopRequested.delete(entry.id);
			this.router.removeAgent(entry.id);
		}
		await Promise.all(entries.map((entry) => this.opts.registry.remove(entry.path)));
		this.correlationToTarget.clear();
		this.router.close();
	}

	/** Returns the live immediate child holding this session UUID, if any. */
	findLiveHolder(sessionId: string): string | undefined {
		return this.opts.registry
			.listChildren(this.opts.ownerPath)
			.find((snapshot) => snapshot.sessionId === sessionId)
			?.localId ?? undefined;
	}

	/** Resolve a child session UUID to a session file within this parent's directory. */
	resolveSessionFile(sessionId: string): string | undefined {
		let sessionsDir = this.sessionDir;
		if (!sessionsDir) {
			const parentSessionFile = this.opts.parentSessionFile;
			if (!parentSessionFile) return undefined;
			sessionsDir = getPersistencePaths(parentSessionFile).childSessionsDir;
		}
		if (!fs.existsSync(sessionsDir)) return undefined;
		try {
			const suffix = `_${sessionId}.jsonl`;
			const match = fs.readdirSync(sessionsDir).find((name) => name.endsWith(suffix));
			return match ? path.join(sessionsDir, match) : undefined;
		} catch {
			return undefined;
		}
	}

	/** Resolve the persisted record attached to a session UUID, including removed records. */
	findPersistedAgentRecord(sessionId: string): PersistedAgentRecord | undefined {
		const parentSessionFile = this.opts.parentSessionFile;
		return parentSessionFile ? findAgentRecordBySessionId(parentSessionFile, sessionId) : undefined;
	}

	private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.mutationTail.then(operation, operation);
		this.mutationTail = run.then(() => undefined, () => undefined);
		return run;
	}

	private ensureSessionDirectory(): void {
		if (this.sessionDir) return;
		const parentSessionFile = this.opts.parentSessionFile;
		if (!parentSessionFile) throw new Error("Subagents require a persisted parent session file");
		const paths = this.persistence ?? getPersistencePaths(parentSessionFile);
		fs.mkdirSync(paths.childSessionsDir, { recursive: true });
		this.sessionDir = paths.childSessionsDir;
	}

	private assertSpawnableIds(agents: AgentSpec[]): void {
		const ids = new Set<string>();
		for (const agent of agents) {
			if (agent.id === "parent") throw new Error('"parent" is a reserved agent id');
			if (ids.has(agent.id)) throw new Error(`Duplicate agent id: "${agent.id}"`);
			ids.add(agent.id);
			if (this.opts.registry.get(childAgentPath(this.opts.ownerPath, agent.id))) {
				throw new Error(`Agent id "${agent.id}" already exists`);
			}
		}
	}

	private createEntry(
		spec: AgentSpec,
		port: MessagePort,
		batch: AgentSpec[],
	): AgentEntry {
		const channels = this.channelsFor(spec, batch);
		const initialOperational = this.initialOperational(spec);
		const forkSpec = spec.kind === "fork" ? spec : undefined;
		return {
			path: childAgentPath(this.opts.ownerPath, spec.id),
			id: spec.id,
			agentDef: spec.kind === "agent" ? spec.agent : undefined,
			persona: spec.personaName,
			personaIcon: spec.personaIcon,
			task: spec.task,
			channels,
			kind: spec.kind,
			cwd: spec.kind === "agent" ? spec.cwd : undefined,
			forkTools: forkSpec?.tools === undefined ? undefined : [...forkSpec.tools],
			forkSkillPaths: forkSpec?.skillPaths === undefined ? undefined : [...forkSpec.skillPaths],
			port,
			seenAssistantMessages: new WeakSet<object>(),
			usageBaseline: { ...initialOperational.usage },
			completionNotified: false,
			completionPending: false,
			committed: false,
			provisionalOperational: initialOperational,
		};
	}

	private createNodeRequest(
		spec: AgentSpec,
		agentConfigs: AgentConfig[],
		entry: AgentEntry,
		batch: AgentSpec[],
	): CreateAgentNodeRequest {
		const agentConfig = spec.kind === "agent" && spec.agent
			? agentConfigs.find((candidate) => candidate.name === spec.agent)
			: undefined;
		const sessionDir = this.sessionDir!;
		const target = this.sessionTarget(spec, sessionDir);
		const identityXml = this.identityPrompt(spec, agentConfigs, entry.channels, batch);
		const skillPaths = this.skillPathsFor(spec);
		// The spawned persona body travels as a first-class payload (recorded on
		// the child's session manager), never as addendum prompt. Restored
		// children are re-marked with the same re-resolved payload.
		const persona: PersonaPayload | undefined = agentConfig
			? { name: agentConfig.name, body: agentConfig.systemPrompt }
			: undefined;
		const appendSystemPrompt = [identityXml];
		const forkSpec = spec.kind === "fork" ? spec : undefined;
		// One active persona file per child, read exactly once per construction:
		// the winning capabilities ride the spec (tools below; skills and model as
		// already-resolved values), so the declaration is never re-read here and
		// an edit between two reads cannot mix capabilities. An absent
		// `personaTools` field selects the ordinary child/fork baseline.
		const toolPolicy = spec.personaTools !== undefined
			? resolveChildToolPolicy({ kind: "persona", tools: [...spec.personaTools] })
			: spec.kind === "fork"
				? forkSpec?.tools === undefined
					? resolveChildToolPolicy({ kind: "default" })
					: resolveChildToolPolicy({ kind: "fork", parentActiveTools: forkSpec.tools })
				: resolveChildToolPolicy({ kind: "default" });

		return {
			localId: entry.id,
			task: entry.task,
			agentDef: entry.agentDef,
			persona: entry.persona,
			personaIcon: entry.personaIcon,
			channels: [...entry.channels],
			session: {
				target,
				// Fresh specs already carry the resolved winning model (persona pin
				// first, explicit argument as gap-fill). A resumed spec carries one only
				// when resurrection resolved an override; otherwise it stays absent so
				// the persisted session keeps its concrete model.
				modelRef: spec.model,
				thinkingLevel: spec.thinkingLevel as any,
				toolPolicy,
				skillPaths,
				noSkills: spec.noSkills,
				appendSystemPrompt,
				persona,
				uplink: entry.port,
			},
			hooks: {
				onEvent: (event) => this.applyChildEvent(entry, event),
				onDiagnostic: (message, type) => this.applyChildDiagnostic(entry, message, type),
				onSessionChanged: () => this.persistReplacement(entry),
				onRuntimeReplaced: () => {},
				getCapabilities: ({ session }) => createChildCapabilities(session),
				onShutdownRequested: () => this.markRuntimeDead(entry, "Child runtime became unavailable"),
			},
			initialOperational: entry.provisionalOperational!,
		};
	}

	private sessionTarget(spec: AgentSpec, sessionDir: string): CreateAgentNodeRequest["session"]["target"] {
		if (spec.resumeSessionFile) {
			return { kind: "resume", sessionFile: spec.resumeSessionFile, sessionDir };
		}
		if (spec.kind === "fork") {
			return {
				kind: "fork",
				sourceSessionFile: spec.sessionFile,
				cwd: this.opts.cwd,
				sessionDir,
			};
		}
		return { kind: "new", cwd: spec.cwd ?? this.opts.cwd, sessionDir };
	}

	private skillPathsFor(spec: AgentSpec): string[] {
		return [...(spec.skillPaths ?? [])];
	}

	private channelsFor(spec: AgentSpec, batch: AgentSpec[]): string[] {
		if (spec.kind === "agent") {
			return [...(spec.channels ?? []), "parent"];
		}
		const channels = this.getAgentStatuses().map((status) => status.id);
		for (const candidate of batch) {
			if (candidate.id !== spec.id && !channels.includes(candidate.id)) channels.push(candidate.id);
		}
		if (!channels.includes("parent")) channels.push("parent");
		return channels;
	}

	private identityPrompt(
		spec: AgentSpec,
		agentConfigs: AgentConfig[],
		channels: string[],
		batch: AgentSpec[],
	): string {
		const candidates: Array<{ id: string; persona?: string; isDefault: boolean }> = [
			...this.entries.map((entry) => ({
				id: entry.id,
				persona: entry.agentDef,
				isDefault: entry.agentDef === undefined,
			})),
			...batch.map((candidate) => ({
				id: candidate.id,
				persona: candidate.kind === "agent" ? candidate.agent : undefined,
				isDefault: candidate.kind === "agent" ? candidate.agent === undefined : false,
			})),
		];
		const peers = candidates
			.filter((candidate) => candidate.id !== spec.id && channels.includes(candidate.id))
			.map((candidate) => ({
				id: candidate.id,
				description: candidate.persona
					? agentConfigs.find((config) => config.name === candidate.persona)?.description
					: undefined,
				isDefault: candidate.isDefault,
			}));
		peers.push({
			id: "parent",
			description:
				"The orchestrating agent that spawned you. It can see all active agents' status and decides when to add, remove, or redirect work. Send it questions when you need human-level judgment or decisions that affect multiple agents.",
		});
		return serializeSubagentIdentity({ id: spec.id, task: spec.task, peers });
	}

	private initialOperational(spec: AgentSpec): AgentOperationalSnapshot {
		if (this.restoring && spec.resumeSessionFile) {
			const snapshot = parseSessionSnapshot(spec.resumeSessionFile);
			// A resurrected spec may carry a model that outranks the persisted one,
			// so the seeded status names the model the child now runs on.
			const modelRef = spec.model ?? snapshot.model;
			const parsedModel = modelRef ? stripThinkingSuffix(modelRef) : undefined;
			return {
				state: "idle",
				usage: { ...snapshot.usage },
				model: parsedModel?.model,
				thinkingLevel: parsedModel?.thinking,
				lastOutput: snapshot.lastOutput,
				lastTurnInput: snapshot.lastTurnInput,
				contextWindow: parsedModel?.model ? this.opts.resolveContextWindow(parsedModel.model) : undefined,
				hasSubgroup: this.childHasLiveSubagents(spec.resumeSessionFile),
				pendingCorrelations: [],
				waitingFor: [],
			};
		}
		const parsedModel = spec.model ? stripThinkingSuffix(spec.model) : undefined;
		return {
			state: "running",
			usage: zeroUsage(),
			model: parsedModel?.model,
			thinkingLevel: spec.thinkingLevel ?? parsedModel?.thinking,
			lastTurnInput: 0,
			hasSubgroup: false,
			pendingCorrelations: [],
			waitingFor: [],
		};
	}

	private submitInitialTask(entry: AgentEntry): void {
		const node = this.opts.registry.get(entry.path);
		if (!node || node.snapshot.ownership !== "registry") return;
		// Every child can have a startup continuation in flight when its session
		// binds (for example, session-resume's automatic continuation). Queue the
		// task behind that turn instead of treating the expected busy preflight as
		// a runtime failure. The child's lifecycle events remain authoritative for
		// status while that continuation runs.
		const streamingBehavior = "followUp" as const;
		entry.pendingTerminalError = undefined;
		const submission = node.session.submit(`Task: ${entry.task}`, streamingBehavior);
		void submission.catch((error) => {
			// A rejected submit means the task never landed, but the session is
			// still there: treat it as errored so a send can retry the prompt.
			if (!this.isActiveEntry(entry)) return;
			this.settleErrored(entry, errorMessage(error) || "Child rejected its initial task");
		});
	}

	private applyChildEvent(entry: AgentEntry, event: any): void {
		if (!this.isActiveEntry(entry)) return;

		if (event.type === "tool_execution_start") {
			const current = this.operationalFor(entry);
			const lifecycle = current.state === "dead"
				? {}
				: { state: "running" as const, lastError: undefined };
			const next = operationalWith(current, {
				...lifecycle,
				lastActivity: `${event.toolName}(${summarizeArgs(event.args)})`.replace(/[\r\n]+/g, " "),
				hasSubgroup: event.toolName === "subagent" || event.toolName === "fork"
					? true
					: event.toolName === "teardown"
						? false
						: current.hasSubgroup,
			});
			this.replaceOperational(entry, next);
			if (current.state !== "dead") entry.pendingTerminalError = undefined;
			return;
		}

		if (event.type === "entry_appended" && event.entry?.type === "usage") {
			// Cache warming and other model-attributed session entries are not
			// assistant messages, but pi still includes their usage in session cost.
			this.recordToolUsage(entry, event.entry.usage);
			return;
		}

		if (event.type === "tool_execution_end") {
			// Pi places nested model work on the direct tool result's `usage`.
			// Nested execution events carry a parent id, while the enclosing result
			// already contains their combined usage, so count only that outer result.
			if (!event.parentToolCallId) this.recordToolUsage(entry, event.result?.usage);
			return;
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			this.recordAssistantMessage(entry, event.message);
			return;
		}

		if (event.type === "thinking_level_changed") {
			if (typeof event.level !== "string") return;
			this.replaceOperational(entry, operationalWith(this.operationalFor(entry), {
				thinkingLevel: event.level,
			}));
			return;
		}

		if (event.type === "agent_start") {
			this.opts.onAgentStart?.(this, entry.id);
			entry.completionNotified = false;
			const current = this.operationalFor(entry);
			// A run starting on an errored agent is its revival: clear the recorded
			// error. Only a dead runtime can never start again.
			if (current.state !== "dead") {
				entry.pendingTerminalError = undefined;
				this.replaceOperational(entry, operationalWith(current, {
					state: "running",
					lastError: undefined,
				}));
			}
			return;
		}

		if (event.type === "agent_end") {
			if (event.willRetry) return;
			entry.pendingTerminalError = finalAssistantError(event.messages);
			return;
		}

		if (event.type === "agent_settled") {
			this.settleAtBoundary(entry, event.aborted === true);
		}
	}

	private recordToolUsage(entry: AgentEntry, usage: any): void {
		if (!usage || typeof usage !== "object") return;
		const current = this.operationalFor(entry);
		const costBreakdown = addCostBreakdown(
			current.usage.costBreakdown,
			costBreakdownFromUsage(usage),
		);
		this.replaceOperational(entry, operationalWith(current, {
			usage: {
				input: current.usage.input + (usage.input || 0),
				output: current.usage.output + (usage.output || 0),
				cacheRead: current.usage.cacheRead + (usage.cacheRead || 0),
				cacheWrite: current.usage.cacheWrite + (usage.cacheWrite || 0),
				cost: current.usage.cost + (usage.cost?.total || 0),
				turns: current.usage.turns,
				...(costBreakdown !== undefined ? { costBreakdown } : {}),
			},
		}));
	}

	private recordAssistantMessage(entry: AgentEntry, message: any): void {
		if (message && typeof message === "object") {
			if (entry.seenAssistantMessages.has(message)) return;
			entry.seenAssistantMessages.add(message);
		}

		const current = this.operationalFor(entry);
		const usage = message.usage;
		const messageModel = typeof message.model === "string" ? message.model : undefined;
		const messageThinkingLevel = typeof message.thinkingLevel === "string" ? message.thinkingLevel : undefined;
		let lastOutput = current.lastOutput;
		for (const part of message.content ?? []) {
			if (part?.type === "text" && typeof part.text === "string") lastOutput = part.text;
		}
		const input = usage?.input || 0;
		const cacheRead = usage?.cacheRead || 0;
		const cacheWrite = usage?.cacheWrite || 0;
		const lifecycle = current.state === "dead"
			? {}
			: { state: "running" as const, lastError: undefined };
		const costBreakdown = addCostBreakdown(
			current.usage.costBreakdown,
			costBreakdownFromUsage(usage),
		);
		this.replaceOperational(entry, operationalWith(current, {
			...lifecycle,
			usage: {
				input: current.usage.input + input,
				output: current.usage.output + (usage?.output || 0),
				cacheRead: current.usage.cacheRead + cacheRead,
				cacheWrite: current.usage.cacheWrite + cacheWrite,
				cost: current.usage.cost + (usage?.cost?.total || 0),
				turns: current.usage.turns + 1,
				...(costBreakdown !== undefined ? { costBreakdown } : {}),
			},
			model: messageModel ?? current.model,
			thinkingLevel: messageThinkingLevel ?? current.thinkingLevel,
			lastOutput,
			lastTurnInput: input + cacheRead + cacheWrite,
			contextWindow: current.contextWindow ?? (messageModel
				? this.opts.resolveContextWindow(messageModel)
				: undefined),
		}));
		// An assistant message proves the child reached a live model run. Clear a
		// pending terminal error if event delivery left one behind. Dead stays terminal.
		if (current.state !== "dead") entry.pendingTerminalError = undefined;
	}

	private applyChildDiagnostic(
		entry: AgentEntry,
		message: string,
		type?: "info" | "warning" | "error",
	): void {
		if (!this.isActiveEntry(entry)) return;
		const label = type === "error" ? "Child resource error" : "Child resource diagnostic";
		this.opts.onParentMessage(
			this.parentPort,
			serializeAgentMessage({ from: entry.id, content: `${label}: ${message}`, responseExpected: false }),
			{ responseExpected: false },
		);
	}

	private settleAtBoundary(entry: AgentEntry, aborted = false): void {
		const current = this.operationalFor(entry);
		if (isSettledState(current.state)) return;
		const stopped = aborted || this.stopRequested.delete(entry.id);
		if (entry.pendingTerminalError && !stopped) {
			this.settleErrored(entry, entry.pendingTerminalError);
			return;
		}
		this.replaceOperational(entry, operationalWith(current, {
			state: "idle",
			lastActivity: undefined,
			lastError: undefined,
		}));
		this.router.agentIdle(entry.id);
		this.notifyCompletion(entry, stopped ? { aborted: true } : undefined);
	}

	/**
	 * Settle an agent whose run ended in an error. The session stays live and
	 * reachable: pending waits are completed with the error, but the routing
	 * endpoint is left connected so a later send revives the agent.
	 */
	private settleErrored(entry: AgentEntry, error: string): void {
		const current = this.operationalFor(entry);
		if (current.state === "errored" || current.state === "dead") return;
		entry.pendingTerminalError = undefined;
		this.replaceOperational(entry, operationalWith(current, {
			state: "errored",
			lastActivity: undefined,
			lastError: error,
		}));
		this.router.agentErrored(entry.id, error);
		this.notifyCompletion(entry);
	}

	/**
	 * Settle an agent whose runtime is gone. This is the one terminal state:
	 * the endpoint is tombstoned, and only teardown + resurrect brings the id
	 * back.
	 */
	private markRuntimeDead(entry: AgentEntry, error: string): void {
		if (!this.isActiveEntry(entry)) return;
		const current = this.operationalFor(entry);
		if (current.state === "dead") return;
		const failure = error || "Child runtime became unavailable";
		entry.pendingTerminalError = undefined;
		this.replaceOperational(entry, operationalWith(current, {
			state: "dead",
			lastActivity: undefined,
			lastError: failure,
		}));
		this.router.agentUnavailable(entry.id, failure);
		this.notifyCompletion(entry);
	}

	private notifyCompletion(entry: AgentEntry, outcome?: AgentCompletionOutcome): void {
		if (!entry.committed) {
			entry.completionPending = true;
			return;
		}
		// The coordinator can hold a settled result while a child view is open.
		// Mark it only after the coordinator accepts the completion for delivery.
		// `undefined` keeps compatibility with direct manager callers that do not
		// return a delivery decision.
		const delivered = outcome === undefined
			? this.opts.onAgentComplete(this, entry.id, this.allDone())
			: this.opts.onAgentComplete(this, entry.id, this.allDone(), outcome);
		if (delivered !== false) entry.completionNotified = true;
	}

	private markAgentWaiting(agentId: string, correlationId: string, targetId: string): void {
		const target = {
			localId: targetId,
			path: targetId === "parent"
				? [...this.opts.ownerPath]
				: childAgentPath(this.opts.ownerPath, targetId),
		};
		this.correlationToTarget.set(correlationId, target);
		if (agentId === "parent") {
			const owner = this.opts.registry.get(this.opts.ownerPath);
			if (!owner) return;
			const current = owner.snapshot.operational;
			if (current.state === "dead") return;
			this.opts.registry.updateOperational(this.opts.ownerPath, operationalWith(current, {
				state: "waiting",
				pendingCorrelations: [...current.pendingCorrelations, correlationId],
				waitingFor: [...current.waitingFor, targetId],
				waitingForPaths: [...(current.waitingForPaths ?? []), [...target.path]],
			}));
			return;
		}
		const entry = this.findEntry(agentId);
		if (!entry) return;
		const current = this.operationalFor(entry);
		if (current.state === "dead") return;
		this.replaceOperational(entry, operationalWith(current, {
			state: "waiting",
			pendingCorrelations: [...current.pendingCorrelations, correlationId],
			waitingFor: [...current.waitingFor, targetId],
			waitingForPaths: [...(current.waitingForPaths ?? []), [...target.path]],
		}));
	}

	private clearAgentWaiting(agentId: string, correlationId: string): void {
		const target = this.correlationToTarget.get(correlationId);
		this.correlationToTarget.delete(correlationId);
		if (agentId === "parent") {
			const owner = this.opts.registry.get(this.opts.ownerPath);
			if (!owner) return;
			const current = owner.snapshot.operational;
			const pendingCorrelations = current.pendingCorrelations.filter((id) => id !== correlationId);
			const waitingFor = removeCorrelationTarget(current, correlationId, target);
			this.opts.registry.updateOperational(this.opts.ownerPath, operationalWith(current, {
				state: pendingCorrelations.length === 0 && current.state === "waiting" ? "running" : current.state,
				pendingCorrelations,
				waitingFor: waitingFor.local,
				waitingForPaths: waitingFor.paths,
			}));
			return;
		}
		const entry = this.findEntry(agentId);
		if (!entry) return;
		const current = this.operationalFor(entry);
		const pendingCorrelations = current.pendingCorrelations.filter((id) => id !== correlationId);
		const waitingFor = removeCorrelationTarget(current, correlationId, target);
		this.replaceOperational(entry, operationalWith(current, {
			state: pendingCorrelations.length === 0 && current.state === "waiting" ? "running" : current.state,
			pendingCorrelations,
			waitingFor: waitingFor.local,
			waitingForPaths: waitingFor.paths,
		}));
	}

	private deliverParentMessage(message: RoutedMessage): void {
		const xml = serializeAgentMessage({
			from: message.from,
			content: message.message,
			correlationId: message.correlationId,
			responseExpected: message.responseExpected,
		});
		this.opts.onParentMessage(this.parentPort, xml, {
			from: message.from,
			correlationId: message.correlationId,
			responseExpected: message.responseExpected,
		});
	}

	private persistReplacement(entry: AgentEntry): void {
		if (!entry.committed || !this.isActiveEntry(entry)) return;
		this.appendCurrentAgentRecord(entry, true);
	}

	private appendCurrentAgentRecord(entry: AgentEntry, replacement: boolean): void {
		const snapshot = this.opts.registry.getSnapshot(entry.path);
		if (!snapshot?.sessionFile) return;
		const persistence = this.ensurePersistence();
		appendAgentAdded(persistence, {
			id: entry.id,
			kind: entry.kind,
			task: entry.task,
			channels: entry.channels.filter((channel) => channel !== "parent"),
			agent: entry.agentDef,
			personaName: entry.persona,
			personaIcon: entry.personaIcon,
			sessionFile: snapshot.sessionFile,
			sessionId: snapshot.sessionId,
			cwd: replacement ? snapshot.cwd : entry.cwd,
			tools: entry.forkTools,
			skillPaths: entry.forkSkillPaths,
		});
	}

	private ensurePersistence(): PersistencePaths {
		if (this.persistence) return this.persistence;
		const parentSessionFile = this.opts.parentSessionFile;
		if (!parentSessionFile) throw new Error("Subagents require a persisted parent session file");
		this.persistence = ensurePersistence(parentSessionFile);
		this.sessionDir = this.persistence.childSessionsDir;
		return this.persistence;
	}

	private operationalFor(entry: AgentEntry): AgentOperationalSnapshot {
		return this.opts.registry.getSnapshot(entry.path)?.operational
			?? entry.provisionalOperational
			?? zeroOperational();
	}

	private replaceOperational(entry: AgentEntry, next: AgentOperationalSnapshot): void {
		const current = this.operationalFor(entry);
		if (operationalEqual(current, next)) return;
		if (!entry.committed) entry.provisionalOperational = next;
		this.opts.registry.updateOperational(entry.path, next);
		if (entry.committed) this.opts.onUpdate(this);
	}

	private findEntry(agentId: string): AgentEntry | undefined {
		return this.entries.find((entry) => entry.id === agentId)
			?? Array.from(this.pendingEntries).find((entry) => entry.id === agentId);
	}

	private isActiveEntry(entry: AgentEntry): boolean {
		return this.entries.includes(entry) || this.pendingEntries.has(entry);
	}

	private allDone(): boolean {
		const allSettled = this.opts.registry
			.listChildren(this.opts.ownerPath)
			.every((snapshot) => isSettledState(snapshot.operational.state));
		return allSettled && this.router.isQuiet();
	}

	private getCompletionReport(): ActiveAgentsCompleteData {
		const entriesById = new Map(this.entries.map((entry) => [entry.id, entry]));
		const agents: AgentCompleteData[] = this.opts.registry
			.listChildren(this.opts.ownerPath)
			.map((snapshot) => {
				const entry = entriesById.get(snapshot.localId ?? "");
				return {
					id: snapshot.localId ?? "",
					status: completionStatus(snapshot.operational.state),
					output: snapshot.operational.lastOutput,
					error: completionError(snapshot.operational),
					sessionId: snapshot.sessionId,
					alreadyNotified: entry?.completionNotified ?? false,
				};
			});
		const usage = this.aggregateUsage();
		return {
			agents,
			usage: {
				input: formatTokenCount(usage.input),
				output: formatTokenCount(usage.output),
				cost: `$${usage.cost.toFixed(4)}`,
			},
		};
	}

	private aggregateUsage(): { input: number; output: number; cost: number } {
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const entry of this.entries) {
			const usage = this.getUsageDelta(entry.id)?.delta;
			if (!usage) continue;
			input += usage.input + usage.cacheRead + usage.cacheWrite;
			output += usage.output;
			cost += usage.cost;
		}
		return { input, output, cost };
	}

	private async teardownAll(): Promise<{ report: string; empty: boolean }> {
		const report = serializeGroupTorndown(this.getCompletionReport());
		const entries = this.entries;
		this.entries = [];

		for (const entry of entries) {
			this.appendRemovalRecord(entry);
			this.router.removeAgent(entry.id);
		}
		await Promise.all(entries.map((entry) => this.opts.registry.remove(entry.path)));
		return { report, empty: true };
	}

	private async teardownSingle(agentId: string): Promise<{ report: string; empty: boolean }> {
		const index = this.entries.findIndex((entry) => entry.id === agentId);
		if (index === -1) throw new Error(`Unknown agent: "${agentId}"`);
		const entry = this.entries[index];
		const snapshot = this.opts.registry.getSnapshot(entry.path);
		if (!snapshot) throw new Error(`Unknown agent: "${agentId}"`);

		const data: AgentCompleteData = {
			id: entry.id,
			status: completionStatus(snapshot.operational.state),
			output: snapshot.operational.lastOutput,
			error: completionError(snapshot.operational),
			sessionId: snapshot.sessionId,
			alreadyNotified: entry.completionNotified,
		};
		const report = serializeAgentTorndown(data);

		this.entries.splice(index, 1);
		this.stopRequested.delete(entry.id);
		this.appendRemovalRecord(entry);
		this.router.removeAgent(entry.id);
		this.dropTargetCorrelations(entry.id);
		await this.opts.registry.remove(entry.path);

		return { report, empty: !this.hasAgents() };
	}

	private appendRemovalRecord(entry: AgentEntry): void {
		if (!this.persistence) return;
		const snapshot = this.opts.registry.getSnapshot(entry.path);
		appendAgentRemoved(this.persistence, {
			id: entry.id,
			sessionFile: snapshot?.sessionFile,
			sessionId: snapshot?.sessionId,
		});
	}

	private dropTargetCorrelations(agentId: string): void {
		for (const [correlationId, targetId] of this.correlationToTarget) {
			if (targetId === agentId) this.correlationToTarget.delete(correlationId);
		}
	}

	/**
	 * Re-derive one restored child's construction inputs from its persisted
	 * record. Capability gates (tools/skills) re-resolve from the active persona
	 * file at the opened session's persisted cwd — workspace declaration first,
	 * else the persisted persona name (DR-033). Model/thinking are deliberately
	 * not re-derived: the persisted session keeps its own (DR-038). The active
	 * file is read exactly once here; its resolved capabilities ride the spec.
	 */
	private toRestoreSpec(agent: PersistedAgentRecord, agentConfigs: AgentConfig[]): AgentSpec {
		const effectiveCwd = agent.cwd ?? this.opts.cwd;
		if (agent.kind === "fork") {
			// Forks have no spawned definition. A workspace declaration replaces
			// the fork snapshot list wholesale; its absence preserves ordinary
			// fork behavior (the persisted snapshot).
			const workspace = loadActivePersona(effectiveCwd, undefined);
			const resolved = workspace?.skills
				? this.resolveRestoredSkills(workspace.skills, agent.id)
				: undefined;
			return {
				kind: "fork",
				id: agent.id,
				personaName: workspace?.name ?? agent.personaName,
				personaIcon: workspace?.icon ?? agent.personaIcon,
				task: agent.task,
				sessionFile: agent.sessionFile,
				resumeSessionFile: agent.sessionFile,
				// An absent legacy tools field is intentionally preserved as undefined:
				// it selects the default policy rather than explicit respond-only mode.
				tools: agent.tools,
				skillPaths: resolved?.skillPaths ?? agent.skillPaths,
				noSkills: resolved !== undefined ? true : undefined,
				personaTools: workspace?.tools,
				thinkingLevel: this.opts.pi.getThinkingLevel() as string,
			} as AgentSpec;
		}
		const persistedWinner = agent.personaName ?? agent.agent;
		const agentConfig = persistedWinner
			? agentConfigs.find((candidate) => candidate.name === persistedWinner)
			: undefined;
		const active = loadActivePersona(effectiveCwd, agentConfig);
		const resolved = active?.skills
			? this.resolveRestoredSkills(active.skills, agent.id)
			: undefined;
		return {
			kind: "agent",
			id: agent.id,
			agent: agent.agent,
			personaName: active?.name ?? agent.personaName,
			personaIcon: active?.icon ?? agent.personaIcon,
			task: agent.task,
			channels: agent.channels,
			resumeSessionFile: agent.sessionFile,
			cwd: agent.cwd,
			skillPaths: resolved?.skillPaths ?? [],
			noSkills: resolved !== undefined ? true : undefined,
			personaTools: active?.tools,
		};
	}

	/**
	 * Resolve an active file's declared skill names against the current command
	 * set for a restored child — the shared `resolvePersonaSkillPaths` resolver
	 * under its `subset` failure policy. A stale list degrades narrow:
	 * unresolvable names are dropped and logged, the resolved remainder is the
	 * complete skill set (`noSkills`), and an all-stale list yields zero skills
	 * — never ordinary discovery. Restore must not fail on a stale list, and
	 * must not widen capabilities because of one.
	 */
	private resolveRestoredSkills(
		skillNames: string[],
		agentId: string,
	): { skillPaths: string[]; dropped: string[] } {
		const resolved = resolvePersonaSkillPaths(skillNames, this.opts.pi.getCommands(), "subset");
		if (resolved.dropped.length > 0) {
			console.error(
				`[subagents] Dropped unresolvable skills for "${agentId}": ${resolved.dropped.join(", ")}`,
			);
		}
		return resolved;
	}
}

function createChildCapabilities(session: any): Record<string, unknown> {
	const executeBash = (...args: readonly unknown[]) => {
		const command = args[0];
		if (typeof command !== "string") throw new TypeError("Child bash command must be a string");
		return session.executeBash(command, undefined, args[1]);
	};
	return {
		operations: [
			"prompt", "steer", "follow_up", "stop", "bash", "abort_bash", "set_model",
			"cycle_model", "set_thinking_level", "cycle_thinking_level", "set_auto_compaction",
			"compact", "tree", "completion", "state", "meta",
		],
		renderer: { visible: true },
		resolveModel: (provider: string, modelId: string) => session.modelRuntime?.getModel?.(provider, modelId),
		getSettings: () => ({
			availableThinkingLevels: session.getAvailableThinkingLevels?.() ?? [],
			autoCompactionEnabled: session.autoCompactionEnabled,
			sessionName: session.sessionName,
		}),
		nativeBash: { admitted: true, execute: executeBash, abort: () => session.abortBash?.() },
		executeBash,
	};
}

function projectStatus(snapshot: AgentNodeSnapshot): AgentStatus {
	const operational = snapshot.operational;
	return {
		id: snapshot.localId ?? "",
		incarnation: snapshot.incarnation,
		state: operational.state,
		agentDef: snapshot.agentDef,
		persona: snapshot.persona,
		personaIcon: snapshot.personaIcon,
		task: snapshot.task ?? "",
		channels: [...snapshot.channels],
		lastActivity: operational.lastActivity,
		usage: {
			...operational.usage,
			...(operational.usage.costBreakdown
				? { costBreakdown: { ...operational.usage.costBreakdown } }
				: {}),
		},
		model: operational.model,
		thinkingLevel: operational.thinkingLevel,
		lastOutput: operational.lastOutput,
		lastError: operational.lastError,
		pendingCorrelations: [...operational.pendingCorrelations],
		lastTurnInput: operational.lastTurnInput,
		contextWindow: operational.contextWindow,
		hasSubgroup: operational.hasSubgroup,
		waitingFor: [...operational.waitingFor],
		waitingForPaths: operational.waitingForPaths?.map((path) => [...path]),
	};
}

function zeroUsage(): AgentOperationalSnapshot["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(first: AgentUsage, second: AgentUsage): AgentUsage {
	const costBreakdown = addCostBreakdown(first.costBreakdown, second.costBreakdown);
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		cost: first.cost + second.cost,
		turns: first.turns + second.turns,
		...(costBreakdown !== undefined ? { costBreakdown } : {}),
	};
}

function samePath(first: AgentPath, second: AgentPath): boolean {
	return first.length === second.length && first.every((part, index) => part === second[index]);
}

function subtractUsage(current: AgentUsage, baseline: AgentUsage): AgentUsage {
	const costBreakdown = subtractCostBreakdown(current.costBreakdown, baseline.costBreakdown);
	return {
		input: current.input - baseline.input,
		output: current.output - baseline.output,
		cacheRead: current.cacheRead - baseline.cacheRead,
		cacheWrite: current.cacheWrite - baseline.cacheWrite,
		cost: current.cost - baseline.cost,
		turns: current.turns - baseline.turns,
		...(costBreakdown !== undefined ? { costBreakdown } : {}),
	};
}

function zeroOperational(): AgentOperationalSnapshot {
	return {
		state: "running",
		usage: zeroUsage(),
		lastTurnInput: 0,
		hasSubgroup: false,
		pendingCorrelations: [],
		waitingFor: [],
	};
}

function operationalWith(
	current: AgentOperationalSnapshot,
	changes: Partial<AgentOperationalSnapshot>,
): AgentOperationalSnapshot {
	return {
		...current,
		...changes,
		usage: changes.usage ? { ...changes.usage } : { ...current.usage },
		pendingCorrelations: changes.pendingCorrelations
			? [...changes.pendingCorrelations]
			: [...current.pendingCorrelations],
		waitingFor: changes.waitingFor ? [...changes.waitingFor] : [...current.waitingFor],
		waitingForPaths: changes.waitingForPaths
			? changes.waitingForPaths.map((path) => [...path])
			: current.waitingForPaths?.map((path) => [...path]),
	};
}

function operationalEqual(a: AgentOperationalSnapshot, b: AgentOperationalSnapshot): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function channelSpec(agent: AgentSpec): AgentChannelSpec {
	return {
		id: agent.id,
		channels: agent.kind === "agent" && agent.channels ? [...agent.channels] : undefined,
	};
}

function removeCorrelationTarget(
	current: AgentOperationalSnapshot,
	correlationId: string,
	target: { localId: string; path: AgentPath } | undefined,
): { local: string[]; paths: AgentPath[] } {
	const correlationIndex = current.pendingCorrelations.indexOf(correlationId);
	const local = [...current.waitingFor];
	const paths = (current.waitingForPaths ?? []).map((path) => [...path]);
	if (correlationIndex >= 0) {
		if (correlationIndex < local.length) local.splice(correlationIndex, 1);
		if (correlationIndex < paths.length) paths.splice(correlationIndex, 1);
	} else if (target) {
		const localIndex = local.indexOf(target.localId);
		if (localIndex >= 0) local.splice(localIndex, 1);
		const pathIndex = paths.findIndex((path) => samePath(path, target.path));
		if (pathIndex >= 0) paths.splice(pathIndex, 1);
	}
	return { local, paths };
}

/** Project a settled agent state onto the vocabulary the model is shown. */
function completionStatus(state: AgentState): AgentCompleteData["status"] {
	if (state === "errored") return "errored";
	if (state === "dead") return "dead";
	return "idle";
}

function completionError(operational: { state: AgentState; lastError?: string }): string | undefined {
	if (operational.state === "errored") return operational.lastError || "Child run ended with an error";
	if (operational.state === "dead") return operational.lastError || "Child runtime became unavailable";
	return undefined;
}

function finalAssistantError(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error") return undefined;
		return typeof message.errorMessage === "string"
			? message.errorMessage
			: "Agent run ended with an error";
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function spawnAcknowledgement(agents: AgentSpec[], restoring: boolean, firstStart: boolean): string {
	const ids = agents.map((agent) => agent.id);
	const count = `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
	const spawned = restoring
		? `Agents restored: ${count} (${ids.join(", ")}).`
		: firstStart
			? `Agents spawned: ${count} (${ids.join(", ")}).`
			: `Added ${count} (${ids.join(", ")}) to the existing active set.`;
	return `${spawned} Results will arrive as notifications.\n\nUnless you were explicitly told to do other work after spawning, briefly tell the user what you spawned. Then:\n- If you have useful independent work to do in the meantime, do it.\n- If there is nothing else to do until an agent returns, call await_agents instead of ending your turn idle.\n- If the user might want you to take on other work while the agents run but you don't know what, ask them.`;
}

function summarizeArgs(args: Record<string, any>): string {
	if (!args) return "";
	if (args.command) {
		const command = String(args.command).replace(/[\r\n\t]+/g, " ").replace(/  +/g, " ").trim();
		return command.length > 40 ? `${command.slice(0, 40)}…` : command;
	}
	if (args.path) return String(args.path);
	const keys = Object.keys(args);
	return keys.length === 0 ? "" : keys.slice(0, 2).join(", ");
}
