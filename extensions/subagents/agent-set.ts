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
	resolveSkillPaths,
} from "./agents.js";
import { childAgentPath, type AgentPath } from "./agent-path.js";
import {
	type AgentNodeSnapshot,
	type AgentOperationalSnapshot,
	type AgentSessionRegistry,
	type CreateAgentNodeRequest,
} from "./agent-session-registry.js";
import { resolveChildToolPolicy } from "./child-tool-policy.js";
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
import {
	addToTopology,
	buildTopology,
	removeFromTopology,
	validateTopology,
	type Topology,
} from "./channels.js";
import {
	MessageRouter,
	type MessagePort,
	type RoutedMessage,
} from "./message-router.js";
import { parseSessionSnapshot } from "./session-snapshot.js";
import { formatTokenCount } from "./format.js";
import {
	serializeAgentMessage,
	serializeAgentTorndown,
	serializeGroupTorndown,
	serializeSubagentIdentity,
	type ActiveAgentsCompleteData,
	type AgentCompleteData,
} from "./messages.js";

export type AgentState = "running" | "idle" | "waiting" | "failed";

export interface AgentStatus {
	id: string;
	state: AgentState;
	agentDef?: string;
	task: string;
	channels: string[];
	lastActivity?: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	model?: string;
	lastOutput?: string;
	/** Error from the final failed run, surfaced in idle notifications. */
	lastError?: string;
	pendingCorrelations: string[];
	lastTurnInput: number;
	contextWindow?: number;
	hasSubgroup: boolean;
	waitingFor: string[];
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
	readonly task: string;
	readonly channels: string[];
	readonly kind: AgentSpec["kind"];
	readonly cwd?: string;
	readonly forkTools?: string[];
	readonly forkSkillPaths?: string[];
	readonly port: MessagePort;
	readonly seenAssistantMessages: WeakSet<object>;
	completionNotified: boolean;
	agentStartedSinceLastPrompt: boolean;
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
	skillPaths: Map<string, string[]>;
	resolveContextWindow: (modelId: string) => number | undefined;
	onUpdate: (mgr: SubagentManager) => void;
	onAgentComplete: (mgr: SubagentManager, agentId: string, allDone: boolean) => void;
	onParentMessage: (xml: string, meta: { correlationId?: string; responseExpected: boolean }) => void;
}

export class SubagentManager {
	private entries: AgentEntry[] = [];
	private readonly pendingEntries = new Set<AgentEntry>();
	private router: MessageRouter | null = null;
	private topology: Topology | null = null;
	private parentPort: MessagePort | null = null;
	private unsubscribeParentPort: (() => void) | null = null;
	private readonly opts: SubagentManagerOptions;
	private readonly correlationToTarget = new Map<string, string>();
	private sessionDir: string | null = null;
	private persistence: PersistencePaths | null = null;
	private restoring = false;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(opts: SubagentManagerOptions) {
		this.opts = opts;
	}

	getAgentStatuses(): AgentStatus[] {
		return this.opts.registry.listChildren(this.opts.ownerPath).map(projectStatus);
	}

	getAgentStatus(agentId: string): AgentStatus | undefined {
		const snapshot = this.opts.registry
			.listChildren(this.opts.ownerPath)
			.find((candidate) => candidate.localId === agentId);
		return snapshot ? projectStatus(snapshot) : undefined;
	}

	hasAgents(): boolean {
		return this.opts.registry.listChildren(this.opts.ownerPath).length > 0;
	}

	/** Parent endpoint for this manager's local routing namespace. */
	getParentPort(): MessagePort | undefined {
		return this.parentPort ?? undefined;
	}

	/**
	 * Abort the target agent's current operation (equivalent to pressing Escape
	 * in the TUI). A failed child is deliberately a no-op for parity.
	 */
	async interrupt(agentId: string): Promise<void> {
		const childPath = childAgentPath(this.opts.ownerPath, agentId);
		const node = this.opts.registry.get(childPath);
		if (!node || node.snapshot.ownership !== "registry") {
			throw new Error(`Unknown agent: "${agentId}"`);
		}
		if (node.snapshot.operational.state === "failed") return;
		await node.session.abort();
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

		const firstStart = this.router === null;
		let topologyBefore: Topology | undefined;
		let createdEntries: AgentEntry[] = [];

		try {
			if (firstStart) {
				this.initializeRouting(agents);
			} else {
				topologyBefore = cloneTopology(this.topology!);
				this.extendTopology(agents);
			}

			const router = this.router!;
			const ports = new Map<string, MessagePort>();
			for (const spec of agents) {
				ports.set(spec.id, router.connect(spec.id));
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
			this.rollbackRouting(agents, firstStart, topologyBefore);
			throw error;
		}
	}

	async restoreFromPersistence(agentConfigs: AgentConfig[]): Promise<void> {
		return this.serializeMutation(() => this.restoreFromPersistenceUnlocked(agentConfigs));
	}

	private async restoreFromPersistenceUnlocked(agentConfigs: AgentConfig[]): Promise<void> {
		if (this.router || this.hasAgents()) return;
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
			await this.startUnlocked(survivors.map((agent) => this.toRestoreSpec(agent)), agentConfigs);
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
			this.router?.agentRemoved(entry.id);
			if (this.topology) removeFromTopology(this.topology, entry.id);
		}
		await Promise.all(entries.map((entry) => this.opts.registry.remove(entry.path)));
		this.resetRouting();
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

	/** Resolve the persisted persona attached to a session UUID, including removed records. */
	findPersistedAgentName(sessionId: string): string | undefined {
		const parentSessionFile = this.opts.parentSessionFile;
		return parentSessionFile ? findAgentRecordBySessionId(parentSessionFile, sessionId)?.agent : undefined;
	}

	private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.mutationTail.then(operation, operation);
		this.mutationTail = run.then(() => undefined, () => undefined);
		return run;
	}

	private initializeRouting(agents: AgentSpec[]): void {
		const parentSessionFile = this.opts.parentSessionFile;
		if (!parentSessionFile) {
			throw new Error("Subagents require a persisted parent session file");
		}

		const specs = channelSpecs(agents);
		const topologyError = validateTopology(specs);
		if (topologyError) throw new Error(topologyError);

		const paths = this.persistence ?? getPersistencePaths(parentSessionFile);
		fs.mkdirSync(paths.childSessionsDir, { recursive: true });
		this.sessionDir = paths.childSessionsDir;
		this.topology = buildTopology([]);
		addToTopology(
			this.topology,
			specs,
			new Set<string>(),
			new Set(agents.filter((agent) => agent.kind === "fork").map((agent) => agent.id)),
		);
		this.router = new MessageRouter({
			topology: this.topology,
			onBlockingSendStart: (from, to, correlationId) => this.markAgentWaiting(from, correlationId, to),
			onBlockingSendEnd: (from, correlationId) => this.clearAgentWaiting(from, correlationId),
		});
		this.parentPort = this.router.connect("parent");
		this.unsubscribeParentPort = this.parentPort.subscribe((message) => this.deliverParentMessage(message));
	}

	private extendTopology(agents: AgentSpec[]): void {
		const existingIds = new Set(this.getAgentStatuses().map((status) => status.id));
		const forkIds = new Set(agents.filter((agent) => agent.kind === "fork").map((agent) => agent.id));
		addToTopology(this.topology!, channelSpecs(agents), existingIds, forkIds);
	}

	private rollbackRouting(
		agents: AgentSpec[],
		firstStart: boolean,
		topologyBefore: Topology | undefined,
	): void {
		for (const spec of agents) {
			this.router?.agentRemoved(spec.id);
		}
		if (firstStart) {
			this.resetRouting();
			return;
		}
		if (topologyBefore && this.topology) restoreTopology(this.topology, topologyBefore);
	}

	private resetRouting(): void {
		this.unsubscribeParentPort?.();
		this.unsubscribeParentPort = null;
		this.router?.close();
		this.router = null;
		this.parentPort = null;
		this.topology = null;
		this.correlationToTarget.clear();
		this.sessionDir = null;
		this.persistence = null;
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
			task: spec.task,
			channels,
			kind: spec.kind,
			cwd: spec.kind === "agent" ? spec.cwd : undefined,
			forkTools: forkSpec?.tools === undefined ? undefined : [...forkSpec.tools],
			forkSkillPaths: forkSpec?.skillPaths === undefined ? undefined : [...forkSpec.skillPaths],
			port,
			seenAssistantMessages: new WeakSet<object>(),
			completionNotified: false,
			agentStartedSinceLastPrompt: false,
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
		const skillPaths = this.skillPathsFor(spec, agentConfig);
		const appendSystemPrompt = [
			...(spec.kind === "agent" && agentConfig && !spec.resumeSessionFile ? [agentConfig.systemPrompt] : []),
			identityXml,
		];
		const forkSpec = spec.kind === "fork" ? spec : undefined;
		const toolPolicy = spec.kind === "fork"
			? forkSpec?.tools === undefined
				? resolveChildToolPolicy({ kind: "default" })
				: resolveChildToolPolicy({ kind: "fork", parentActiveTools: forkSpec.tools })
			: agentConfig?.tools === undefined
				? resolveChildToolPolicy({ kind: "default" })
				: resolveChildToolPolicy({ kind: "persona", tools: agentConfig.tools });

		return {
			localId: entry.id,
			task: entry.task,
			agentDef: entry.agentDef,
			channels: [...entry.channels],
			session: {
				target,
				modelRef: spec.kind === "agent" ? agentConfig?.model ?? spec.model : undefined,
				thinkingLevel: spec.kind === "fork" ? spec.thinkingLevel as any : undefined,
				toolPolicy,
				skillPaths,
				appendSystemPrompt,
				uplink: entry.port,
			},
			hooks: {
				onEvent: (event) => this.applyChildEvent(entry, event),
				onUiNotify: (message, type) => this.applyChildNotification(entry, message, type),
				onDiagnostic: (message, type) => this.applyChildDiagnostic(entry, message, type),
				onSessionChanged: () => this.persistReplacement(entry),
				onShutdownRequested: () => this.markRuntimeUnavailable(entry, "Child runtime became unavailable"),
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

	private skillPathsFor(spec: AgentSpec, agentConfig: AgentConfig | undefined): string[] {
		if (spec.kind === "fork") {
			const forkSpec = spec as ForkAgentSpec & { skillPaths?: string[] };
			return [...(forkSpec.skillPaths ?? [])];
		}

		let paths = this.opts.skillPaths.get(spec.id) ?? [];
		if (paths.length === 0 && agentConfig?.skills) {
			try {
				paths = resolveSkillPaths(agentConfig.skills, this.opts.pi.getCommands());
			} catch (error) {
				console.error(
					`[subagents] Failed to resolve skills for "${spec.id}": ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return [...paths];
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
			return {
				state: "idle",
				usage: { ...snapshot.usage },
				model: snapshot.model,
				lastOutput: snapshot.lastOutput,
				lastTurnInput: snapshot.lastTurnInput,
				contextWindow: snapshot.model ? this.opts.resolveContextWindow(snapshot.model) : undefined,
				hasSubgroup: this.childHasLiveSubagents(spec.resumeSessionFile),
				pendingCorrelations: [],
				waitingFor: [],
			};
		}
		return {
			state: "running",
			usage: zeroUsage(),
			lastTurnInput: 0,
			hasSubgroup: false,
			pendingCorrelations: [],
			waitingFor: [],
		};
	}

	private submitInitialTask(entry: AgentEntry): void {
		const node = this.opts.registry.get(entry.path);
		if (!node || node.snapshot.ownership !== "registry") return;
		entry.agentStartedSinceLastPrompt = false;
		entry.pendingTerminalError = undefined;
		// A forked session may have a pending source turn when its isolated
		// session_start hooks bind (for example, session-resume's automatic
		// continuation). Queue the fork directive behind that turn instead of
		// treating the expected busy preflight as a runtime failure.
		const streamingBehavior = entry.kind === "fork" ? "followUp" : undefined;
		void node.session.submit(`Task: ${entry.task}`, streamingBehavior).catch((error) => {
			this.markRuntimeUnavailable(entry, errorMessage(error));
		});
	}

	private applyChildEvent(entry: AgentEntry, event: any): void {
		if (!this.isActiveEntry(entry)) return;

		if (event.type === "tool_execution_start") {
			const current = this.operationalFor(entry);
			const next = operationalWith(current, {
				lastActivity: `${event.toolName}(${summarizeArgs(event.args)})`.replace(/[\r\n]+/g, " "),
				hasSubgroup: event.toolName === "subagent" || event.toolName === "fork"
					? true
					: event.toolName === "teardown"
						? false
						: current.hasSubgroup,
			});
			this.replaceOperational(entry, next);
			return;
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			this.recordAssistantMessage(entry, event.message);
			return;
		}

		if (event.type === "agent_start") {
			const current = this.operationalFor(entry);
			if (current.state !== "failed") {
				entry.agentStartedSinceLastPrompt = true;
				entry.pendingTerminalError = undefined;
				this.replaceOperational(entry, operationalWith(current, { state: "running" }));
			}
			return;
		}

		if (event.type === "agent_end") {
			if (event.willRetry) return;
			entry.pendingTerminalError = finalAssistantError(event.messages);
			return;
		}

		if (event.type === "agent_settled") {
			this.settleAtBoundary(entry);
		}
	}

	private recordAssistantMessage(entry: AgentEntry, message: any): void {
		if (message && typeof message === "object") {
			if (entry.seenAssistantMessages.has(message)) return;
			entry.seenAssistantMessages.add(message);
		}

		const current = this.operationalFor(entry);
		const usage = message.usage;
		const messageModel = typeof message.model === "string" ? message.model : undefined;
		let lastOutput = current.lastOutput;
		for (const part of message.content ?? []) {
			if (part?.type === "text" && typeof part.text === "string") lastOutput = part.text;
		}
		const input = usage?.input || 0;
		const cacheRead = usage?.cacheRead || 0;
		const cacheWrite = usage?.cacheWrite || 0;
		this.replaceOperational(entry, operationalWith(current, {
			usage: {
				input: current.usage.input + input,
				output: current.usage.output + (usage?.output || 0),
				cacheRead: current.usage.cacheRead + cacheRead,
				cacheWrite: current.usage.cacheWrite + cacheWrite,
				cost: current.usage.cost + (usage?.cost?.total || 0),
				turns: current.usage.turns + 1,
			},
			model: messageModel ?? current.model,
			lastOutput,
			lastTurnInput: input + cacheRead + cacheWrite,
			contextWindow: current.contextWindow ?? (messageModel
				? this.opts.resolveContextWindow(messageModel)
				: undefined),
		}));
	}

	private applyChildDiagnostic(
		entry: AgentEntry,
		message: string,
		type?: "info" | "warning" | "error",
	): void {
		if (!this.isActiveEntry(entry)) return;
		const label = type === "error" ? "Child resource error" : "Child resource diagnostic";
		this.opts.onParentMessage(
			serializeAgentMessage({ from: entry.id, content: `${label}: ${message}`, responseExpected: false }),
			{ responseExpected: false },
		);
	}

	private applyChildNotification(
		entry: AgentEntry,
		message: string,
		type?: "info" | "warning" | "error",
	): void {
		if (type !== "error" || !this.isActiveEntry(entry)) return;
		const current = this.operationalFor(entry);
		if (current.state === "running" && !entry.agentStartedSinceLastPrompt) {
			this.settleFailed(entry, message || "Child input was rejected");
			return;
		}
		if (current.state !== "running") this.router?.agentIdle(entry.id);
	}

	private settleAtBoundary(entry: AgentEntry): void {
		const current = this.operationalFor(entry);
		if (current.state === "failed" || current.state === "idle") return;
		if (entry.pendingTerminalError) {
			this.settleFailed(entry, entry.pendingTerminalError);
			return;
		}
		entry.agentStartedSinceLastPrompt = false;
		this.replaceOperational(entry, operationalWith(current, {
			state: "idle",
			lastActivity: undefined,
			lastError: undefined,
		}));
		this.router?.agentIdle(entry.id);
		this.notifyCompletion(entry);
	}

	private settleFailed(entry: AgentEntry, error: string): void {
		const current = this.operationalFor(entry);
		if (current.state === "failed") return;
		entry.agentStartedSinceLastPrompt = false;
		entry.pendingTerminalError = undefined;
		this.replaceOperational(entry, operationalWith(current, {
			state: "failed",
			lastActivity: undefined,
			lastError: error,
		}));
		this.router?.agentUnavailable(entry.id, error);
		this.notifyCompletion(entry);
	}

	private markRuntimeUnavailable(entry: AgentEntry, error: string): void {
		if (!this.isActiveEntry(entry)) return;
		this.settleFailed(entry, error || "Child runtime became unavailable");
	}

	private notifyCompletion(entry: AgentEntry): void {
		if (!entry.committed) {
			entry.completionPending = true;
			return;
		}
		entry.completionNotified = true;
		this.opts.onAgentComplete(this, entry.id, this.allDone());
	}

	private markAgentWaiting(agentId: string, correlationId: string, targetId: string): void {
		if (agentId === "parent") {
			const owner = this.opts.registry.get(this.opts.ownerPath);
			if (!owner) return;
			const current = owner.snapshot.operational;
			if (current.state === "failed") return;
			this.correlationToTarget.set(correlationId, targetId);
			this.opts.registry.updateOperational(this.opts.ownerPath, operationalWith(current, {
				state: "waiting",
				pendingCorrelations: [...current.pendingCorrelations, correlationId],
				waitingFor: [...current.waitingFor, targetId],
			}));
			return;
		}
		const entry = this.findEntry(agentId);
		if (!entry) return;
		const current = this.operationalFor(entry);
		if (current.state === "failed") return;
		this.correlationToTarget.set(correlationId, targetId);
		this.replaceOperational(entry, operationalWith(current, {
			state: "waiting",
			pendingCorrelations: [...current.pendingCorrelations, correlationId],
			waitingFor: [...current.waitingFor, targetId],
		}));
	}

	private clearAgentWaiting(agentId: string, correlationId: string): void {
		const targetId = this.correlationToTarget.get(correlationId);
		this.correlationToTarget.delete(correlationId);
		if (agentId === "parent") {
			const owner = this.opts.registry.get(this.opts.ownerPath);
			if (!owner) return;
			const current = owner.snapshot.operational;
			const pendingCorrelations = current.pendingCorrelations.filter((id) => id !== correlationId);
			const waitingFor = removeOne(current.waitingFor, targetId);
			this.opts.registry.updateOperational(this.opts.ownerPath, operationalWith(current, {
				state: pendingCorrelations.length === 0 && current.state === "waiting" ? "running" : current.state,
				pendingCorrelations,
				waitingFor,
			}));
			return;
		}
		const entry = this.findEntry(agentId);
		if (!entry) return;
		const current = this.operationalFor(entry);
		const pendingCorrelations = current.pendingCorrelations.filter((id) => id !== correlationId);
		const waitingFor = removeOne(current.waitingFor, targetId);
		this.replaceOperational(entry, operationalWith(current, {
			state: pendingCorrelations.length === 0 && current.state === "waiting" ? "running" : current.state,
			pendingCorrelations,
			waitingFor,
		}));
	}

	private deliverParentMessage(message: RoutedMessage): void {
		const xml = serializeAgentMessage({
			from: message.from,
			content: message.message,
			correlationId: message.correlationId,
			responseExpected: message.responseExpected,
		});
		this.opts.onParentMessage(xml, {
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
			.every((snapshot) => snapshot.operational.state === "idle" || snapshot.operational.state === "failed");
		return allSettled && (this.router?.isQuiet() ?? true);
	}

	private getCompletionReport(): ActiveAgentsCompleteData {
		const entriesById = new Map(this.entries.map((entry) => [entry.id, entry]));
		const agents: AgentCompleteData[] = this.opts.registry
			.listChildren(this.opts.ownerPath)
			.map((snapshot) => {
				const entry = entriesById.get(snapshot.localId ?? "");
				return {
					id: snapshot.localId ?? "",
					status: snapshot.operational.state === "failed" ? "failed" : "idle",
					output: snapshot.operational.lastOutput,
					error: snapshot.operational.state === "failed"
						? snapshot.operational.lastError || "Child runtime failed"
						: undefined,
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
		for (const snapshot of this.opts.registry.listChildren(this.opts.ownerPath)) {
			input += snapshot.operational.usage.input
				+ snapshot.operational.usage.cacheRead
				+ snapshot.operational.usage.cacheWrite;
			output += snapshot.operational.usage.output;
			cost += snapshot.operational.usage.cost;
		}
		return { input, output, cost };
	}

	private async teardownAll(): Promise<{ report: string; empty: boolean }> {
		const report = serializeGroupTorndown(this.getCompletionReport());
		const entries = this.entries;
		this.entries = [];

		for (const entry of entries) {
			this.appendRemovalRecord(entry);
			this.router?.agentRemoved(entry.id);
			if (this.topology) removeFromTopology(this.topology, entry.id);
		}
		await Promise.all(entries.map((entry) => this.opts.registry.remove(entry.path)));
		this.resetRouting();
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
			status: snapshot.operational.state === "failed" ? "failed" : "idle",
			output: snapshot.operational.lastOutput,
			error: snapshot.operational.state === "failed"
				? snapshot.operational.lastError || "Child runtime failed"
				: undefined,
			sessionId: snapshot.sessionId,
			alreadyNotified: entry.completionNotified,
		};
		const report = serializeAgentTorndown(data);

		this.entries.splice(index, 1);
		this.appendRemovalRecord(entry);
		this.router?.agentRemoved(entry.id);
		if (this.topology) removeFromTopology(this.topology, entry.id);
		this.dropTargetCorrelations(entry.id);
		await this.opts.registry.remove(entry.path);

		if (this.hasAgents()) return { report, empty: false };
		this.resetRouting();
		return { report, empty: true };
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

	private toRestoreSpec(agent: PersistedAgentRecord): AgentSpec {
		if (agent.kind === "fork") {
			return {
				kind: "fork",
				id: agent.id,
				task: agent.task,
				sessionFile: agent.sessionFile,
				resumeSessionFile: agent.sessionFile,
				// An absent legacy tools field is intentionally preserved as undefined:
				// it selects the default policy rather than explicit respond-only mode.
				tools: agent.tools,
				skillPaths: agent.skillPaths,
				thinkingLevel: this.opts.pi.getThinkingLevel() as string,
			} as AgentSpec;
		}
		return {
			kind: "agent",
			id: agent.id,
			agent: agent.agent,
			task: agent.task,
			channels: agent.channels,
			resumeSessionFile: agent.sessionFile,
			cwd: agent.cwd,
		};
	}
}

function projectStatus(snapshot: AgentNodeSnapshot): AgentStatus {
	const operational = snapshot.operational;
	return {
		id: snapshot.localId ?? "",
		state: operational.state,
		agentDef: snapshot.agentDef,
		task: snapshot.task ?? "",
		channels: [...snapshot.channels],
		lastActivity: operational.lastActivity,
		usage: { ...operational.usage },
		model: operational.model,
		lastOutput: operational.lastOutput,
		lastError: operational.lastError,
		pendingCorrelations: [...operational.pendingCorrelations],
		lastTurnInput: operational.lastTurnInput,
		contextWindow: operational.contextWindow,
		hasSubgroup: operational.hasSubgroup,
		waitingFor: [...operational.waitingFor],
	};
}

function zeroUsage(): AgentOperationalSnapshot["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
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
	};
}

function operationalEqual(a: AgentOperationalSnapshot, b: AgentOperationalSnapshot): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function channelSpecs(agents: AgentSpec[]): Array<{ id: string; channels?: string[] }> {
	return agents.map((agent) => ({
		id: agent.id,
		channels: agent.kind === "agent" ? agent.channels : undefined,
	}));
}

function cloneTopology(topology: Topology): Topology {
	return new Map(Array.from(topology, ([id, targets]) => [id, new Set(targets)]));
}

function restoreTopology(target: Topology, source: Topology): void {
	target.clear();
	for (const [id, targets] of source) target.set(id, new Set(targets));
}

function removeOne(values: readonly string[], value: string | undefined): string[] {
	if (value === undefined) return [...values];
	const index = values.indexOf(value);
	return index === -1 ? [...values] : [...values.slice(0, index), ...values.slice(index + 1)];
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
