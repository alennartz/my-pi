/**
 * Subagent lifecycle management.
 *
 * Long-lived manager that spawns pi --mode rpc child processes, manages
 * per-agent state, subscribes to RPC event streams for widget updates,
 * and coordinates broker startup/teardown. Infrastructure is created
 * lazily on first start() and torn down when no agents remain.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RpcChild } from "./rpc-child.js";
import { Broker } from "./broker.js";
import { type AgentConfig, type AgentSpec, type ForkAgentSpec, buildAgentArgs, buildForkArgs, isValidCwd, resolveSkillPaths } from "./agents.js";
import { ensurePersistence, appendAgentAdded, appendAgentRemoved, findAgentRecordBySessionId, loadPersistedAgents, getPersistencePaths, pruneInvalidPersistedAgents, type PersistencePaths, type PersistedAgentRecord } from "./persistence.js";
import { type Topology, buildTopology, addToTopology, removeFromTopology, validateTopology } from "./channels.js";
import type { AgentPath } from "./agent-path.js";
import type { AgentSessionRegistry } from "./agent-session-registry.js";
import { parseSessionSnapshot } from "./session-snapshot.js";
import { formatTokenCount } from "./format.js";
import {
	serializeSubagentIdentity,
	serializeAgentMessage,
	serializeGroupTorndown,
	serializeAgentTorndown,
	type ActiveAgentsCompleteData,
	type AgentCompleteData,
	type BrokerResponse,
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
	/**
	 * Error message from the agent's last run, if it ended with stopReason
	 * "error" (provider failure, exhausted retries, etc.) rather than a clean
	 * completion. Propagated into the <agent_idle status="failed"> notification
	 * so the parent sees why the agent failed instead of an empty idle report.
	 */
	lastError?: string;
	pendingCorrelations: string[];
	lastTurnInput: number;
	contextWindow?: number;
	hasSubgroup: boolean;
	waitingFor: string[];
}

interface AgentEntry {
	id: string;
	agentDef?: string;
	task: string;
	channels: string[];
	rpc: RpcChild;
	status: AgentStatus;
	sessionFile?: string;
	sessionId?: string;
	kind: AgentSpec["kind"];
	cwd?: string;
	/** Fork-only: tool restriction captured at fork time, persisted for restore. */
	forkTools?: string[];
	/** Fork-only: resolved skill paths captured at fork time, persisted for restore. */
	forkSkillPaths?: string[];
	/**
	 * True once an <agent_idle> notification has been delivered to the parent
	 * for this agent (set right before onAgentComplete fires). Drives the slim
	 * vs. full body shape in teardown reports — already-notified agents don't
	 * need their output re-emitted.
	 */
	completionNotified: boolean;
	/**
	 * True once the child has emitted agent_start since the most recent prompt
	 * delivered to it. Reset to false on the initial Task: prompt and whenever
	 * the child goes idle (ready for its next prompt). Set to true on
	 * agent_start. Used to detect prompts blocked before the agent began
	 * processing — e.g. when an extension's input handler returns early and
	 * emits an error-level notify instead of letting the run proceed.
	 */
	agentStartedSinceLastPrompt: boolean;
}

export interface SubagentManagerOptions {
	pi: ExtensionAPI;
	cwd: string;
	/** Shared per-root runtime registry; manager owns only its immediate orchestration. */
	registry?: AgentSessionRegistry;
	/** Canonical path of the manager's owning node in the shared registry. */
	ownerPath?: AgentPath;
	parentSessionFile?: string;
	skillPaths: Map<string, string[]>;
	resolveContextWindow: (modelId: string) => number | undefined;
	onUpdate: (mgr: SubagentManager) => void;
	onAgentComplete: (mgr: SubagentManager, agentId: string, allDone: boolean) => void;
	onParentMessage: (xml: string, meta: { correlationId?: string; responseExpected: boolean }) => void;
}

export class SubagentManager {
	private entries: AgentEntry[] = [];
	private broker: Broker | null = null;
	private topology: Topology | null = null;
	private opts: SubagentManagerOptions;
	private correlationToTarget = new Map<string, string>();
	private sessionDir: string | null = null;
	private persistence: PersistencePaths | null = null;
	private restoring = false;

	constructor(opts: SubagentManagerOptions) {
		this.opts = opts;
	}

	getAgentStatuses(): AgentStatus[] {
		return this.entries.map((e) => e.status);
	}

	getAgentStatus(agentId: string): AgentStatus | undefined {
		return this.entries.find((e) => e.id === agentId)?.status;
	}

	hasAgents(): boolean {
		return this.entries.length > 0;
	}

	/** Abort the target agent's current operation (equivalent to pressing Escape in the TUI). */
	async interrupt(agentId: string): Promise<void> {
		const entry = this.entries.find((e) => e.id === agentId);
		if (!entry) throw new Error(`Unknown agent: "${agentId}"`);
		if (entry.status.state === "failed") return;
		await entry.rpc.abort();
	}

	/**
	 * Recompute the subgroup flag for a restored child from its own persistence
	 * log, without replicating the flag into our own records (recompute over
	 * replicate). Returns true iff the child has at least one persisted subagent.
	 */
	private childHasLiveSubagents(childSessionFile: string): boolean {
		const loaded = loadPersistedAgents(childSessionFile);
		return loaded !== null && loaded.agents.length > 0;
	}

	private getCompletionReport(): ActiveAgentsCompleteData {
		const agents: AgentCompleteData[] = this.entries.map((e) => ({
			id: e.id,
			status: e.status.state === "failed" ? "failed" : "idle",
			output: e.status.lastOutput,
			error: e.status.state === "failed" ? (e.status.lastError || e.rpc.stderr || "Process crashed") : undefined,
			sessionId: e.sessionId,
			alreadyNotified: e.completionNotified,
		}));

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

	async start(agents: AgentSpec[], agentConfigs: AgentConfig[]): Promise<string> {
		const { pi, cwd, skillPaths } = this.opts;
		const isFirstCall = this.broker === null;

		// "parent" is reserved: it names the orchestrator in the topology and on
		// the broker. An agent registered under it would clobber the parent's
		// broker connection and topology entry.
		for (const a of agents) {
			if (a.id === "parent") {
				throw new Error('"parent" is a reserved agent id');
			}
		}

		if (isFirstCall) {
			const parentSessionFile = this.opts.parentSessionFile;
			if (!parentSessionFile) {
				throw new Error("Subagents require a persisted parent session file");
			}
			this.persistence = ensurePersistence(parentSessionFile);
			this.sessionDir = this.persistence.childSessionsDir;

			// Build initial topology
			const specs = agents.map((a) => ({
				id: a.id,
				channels: a.kind === "agent" ? a.channels : undefined,
			}));
			const topologyError = validateTopology(specs);
			if (topologyError) {
				throw new Error(topologyError);
			}
			this.topology = buildTopology(specs);

			// Start broker
			this.broker = new Broker({
				topology: this.topology,
				onParentMessage: (msg) => this.handleParentMessage(msg),
				onBlockingSendStart: (from, to, correlationId) => this.setAgentWaiting(from, correlationId, to),
				onBlockingSendEnd: (from, correlationId) => this.clearAgentWaiting(from, correlationId),
			});
			await this.broker.start();
		} else {
			// Extend existing topology
			const existingIds = new Set(this.entries.map((e) => e.id));
			const forkIds = new Set(agents.filter((a) => a.kind === "fork").map((a) => a.id));
			const specs = agents.map((a) => ({
				id: a.id,
				channels: a.kind === "agent" ? a.channels : undefined,
			}));
			addToTopology(this.topology!, specs, existingIds, forkIds);
		}

		// Build and spawn each new agent
		const newEntries: AgentEntry[] = [];

		for (const agentSpec of agents) {
			const channels = agentSpec.kind === "agent" ? (agentSpec.channels ?? []) : [];
			const allChannels = [...channels, "parent"];

			// For fork agents, add all existing agent IDs as channels (parent-equivalent)
			if (agentSpec.kind === "fork") {
				for (const entry of this.entries) {
					if (!allChannels.includes(entry.id)) {
						allChannels.push(entry.id);
					}
				}
			}

			// Build identity XML for system prompt. Normalize all candidates to a
			// uniform shape up front (id/persona/isDefault) so the peer mapping
			// needs no `in`-checks or casts.
			const allAgents: Array<{ id: string; persona?: string; isDefault: boolean }> = [
				...this.entries.map((e) => ({ id: e.id, persona: e.agentDef, isDefault: !e.agentDef })),
				...agents.map((a) => ({
					id: a.id,
					persona: a.kind === "agent" ? a.agent : undefined,
					isDefault: a.kind === "agent" ? !a.agent : false,
				})),
			];
			const peers = allAgents
				.filter((a) => a.id !== agentSpec.id)
				.filter((a) => allChannels.includes(a.id))
				.map((a) => {
					const peerConfig = a.persona
						? agentConfigs.find((c) => c.name === a.persona)
						: undefined;
					return {
						id: a.id,
						description: peerConfig?.description,
						isDefault: a.isDefault,
					};
				});

			// Always add parent as a peer
			peers.push({
				id: "parent",
				description:
					"The orchestrating agent that spawned you. It can see all active agents' status and decides when to add, remove, or redirect work. Send it questions when you need human-level judgment or decisions that affect multiple agents.",

			});

			const identityXml = serializeSubagentIdentity({
				id: agentSpec.id,
				task: agentSpec.task,
				peers,
			});

			// Build args — branch on spec kind
			let args: string[];
			let agentConfig: AgentConfig | undefined;

			if (agentSpec.kind === "fork") {
				args = buildForkArgs(agentSpec, this.sessionDir!);
				// Fork inherits system prompt from session — no agentConfig append
			} else {
				agentConfig = agentSpec.agent ? agentConfigs.find((a) => a.name === agentSpec.agent) : undefined;
				// Skill paths come from the subagent tool (which resolves them at
				// spawn time into the shared map). On resurrect/restore that map is
				// empty, so fall back to re-resolving the persona's declared skills —
				// otherwise the child would boot with the default skill set instead
				// of the persona's pinned skills.
				let agentSkillPaths = skillPaths.get(agentSpec.id) ?? [];
				if (agentSkillPaths.length === 0 && agentConfig?.skills) {
					try {
						agentSkillPaths = resolveSkillPaths(agentConfig.skills, pi.getCommands());
					} catch (err) {
						// Skills no longer resolvable — spawn without them rather than
						// failing the whole restore/resurrect batch.
						console.error(`[subagents] Failed to resolve skills for "${agentSpec.id}": ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				args = buildAgentArgs(
					agentSpec.id,
					agentConfig,
					agentSkillPaths,
					this.sessionDir!,
					agentSpec.resumeSessionFile,
					agentSpec.model,
				);
				if (agentConfig && !agentSpec.resumeSessionFile) {
					args.push("--append-system-prompt", agentConfig.systemPrompt);
				}
			}

			args.push("--append-system-prompt", identityXml);

			// PI_PARENT_LINK env var with identity
			const envPayload = JSON.stringify({
				id: agentSpec.id,
				channels: allChannels,
				task: agentSpec.task,
				brokerSocket: this.broker!.socketPath,
				...(agentConfig?.tools ? { tools: agentConfig.tools } : {}),
			});

			const specCwd = agentSpec.kind === "agent" ? (agentSpec.cwd ?? cwd) : cwd;
			const rpc = new RpcChild({
				cwd: specCwd,
				env: { PI_PARENT_LINK: envPayload },
				args,
			});

			// Identity fields are computed identically for fresh spawns and restores.
			const identity = {
				id: agentSpec.id,
				agentDef: agentSpec.kind === "agent" ? agentSpec.agent : undefined,
				task: agentSpec.task,
				channels: allChannels,
			};

			const restoreFile = this.restoring ? agentSpec.resumeSessionFile : undefined;
			let status: AgentStatus;
			if (restoreFile) {
				// Restore path: recompute faithful status from the child's own
				// session file rather than seeding a fabricated "running"/zeroed
				// state. Seed "idle"; event-driven transitions flip it to
				// "running" if the child auto-resumes.
				const snap = parseSessionSnapshot(restoreFile);
				status = {
					...identity,
					state: "idle",
					usage: snap.usage,
					model: snap.model,
					lastOutput: snap.lastOutput,
					lastTurnInput: snap.lastTurnInput,
					contextWindow: snap.model ? this.opts.resolveContextWindow(snap.model) : undefined,
					hasSubgroup: this.childHasLiveSubagents(restoreFile),
					pendingCorrelations: [],
					waitingFor: [],
				};
			} else {
				status = {
					...identity,
					state: "running",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					pendingCorrelations: [],
					lastTurnInput: 0,
					hasSubgroup: false,
					waitingFor: [],
				};
			}

			const entry: AgentEntry = {
				id: agentSpec.id,
				agentDef: agentSpec.kind === "agent" ? agentSpec.agent : undefined,
				task: agentSpec.task,
				channels: allChannels,
				rpc,
				status,
				kind: agentSpec.kind,
				cwd: agentSpec.kind === "agent" ? agentSpec.cwd : undefined,
				forkTools: agentSpec.kind === "fork" ? agentSpec.tools : undefined,
				forkSkillPaths: agentSpec.kind === "fork" ? agentSpec.skillPaths : undefined,
				completionNotified: false,
				agentStartedSinceLastPrompt: false,
			};

			newEntries.push(entry);
			this.entries.push(entry);

			// Subscribe to RPC events
			rpc.onEvent((event) => this.handleRpcEvent(entry, event));
		}

		// Start new RPC children
		await Promise.all(newEntries.map((e) => e.rpc.start()));

		for (const entry of newEntries) {
			entry.sessionFile = entry.rpc.sessionFile;
			entry.sessionId = entry.rpc.sessionId;
			if (!this.restoring && this.persistence && entry.sessionFile) {
				appendAgentAdded(this.persistence, {
					id: entry.id,
					kind: entry.kind,
					task: entry.task,
					channels: entry.channels.filter((c) => c !== "parent"),
					agent: entry.agentDef,
					sessionFile: entry.sessionFile,
					sessionId: entry.sessionId,
					cwd: entry.cwd,
					tools: entry.forkTools,
					skillPaths: entry.forkSkillPaths,
				});
			}
		}

		// Send initial task prompts. Restored sessions rely on generic session-resume
		// behavior to receive their wake-up message when the session is resumed.
		if (!this.restoring) {
			for (const entry of newEntries) {
				entry.rpc.prompt(`Task: ${entry.task}`).catch(() => {
					// Process may have died
				});
			}
		}

		// Monitor for process exits
		for (const entry of newEntries) {
			this.monitorExit(entry);
		}

		// Build acknowledgment
		const ids = agents.map((a) => a.id);
		const spawned = this.restoring
			? `Agents restored: ${agents.length} agent${agents.length === 1 ? "" : "s"} (${ids.join(", ")}).`
			: isFirstCall
				? `Agents spawned: ${agents.length} agent${agents.length === 1 ? "" : "s"} (${ids.join(", ")}).`
				: `Added ${agents.length} agent${agents.length === 1 ? "" : "s"} (${ids.join(", ")}) to the existing active set.`;
		return `${spawned} Results will arrive as notifications.\n\nUnless you were explicitly told to do other work after spawning, briefly tell the user what you spawned. Then:\n- If you have useful independent work to do in the meantime, do it.\n- If there is nothing else to do until an agent returns, call await_agents instead of ending your turn idle.\n- If the user might want you to take on other work while the agents run but you don't know what, ask them.`;
	}

	async restoreFromPersistence(agentConfigs: AgentConfig[]): Promise<void> {
		if (this.broker || this.entries.length > 0) return;
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
			const restored = survivors.map((agent) => this.toRestoreSpec(agent));
			await this.start(restored, agentConfigs);
		} finally {
			this.restoring = false;
		}
	}

	async teardown(agentId?: string): Promise<{ report: string; empty: boolean }> {
		if (agentId) {
			return this.teardownSingle(agentId);
		}
		return this.teardownAll();
	}

	/**
	 * Tear down OS resources (child processes + broker socket) without modifying
	 * the persistence log. Used for graceful host shutdown, including
	 * `session_shutdown` triggered by quit, reload, or session replacement: the
	 * next `session_start` re-spawns the same logical agents via
	 * `restoreFromPersistence`, which needs the log intact.
	 *
	 * Distinct from `teardownAll`, which is user-initiated agent removal and
	 * therefore must call `appendAgentRemoved` so the agents do not come back
	 * on the next restore cycle.
	 */
	async softShutdown(): Promise<void> {
		// Swap entries out BEFORE stopping — prevents monitorExit from seeing the
		// SIGTERM exit code mid-shutdown and firing spurious crash notifications
		// (mirrors teardownSingle).
		const entries = this.entries;
		this.entries = [];

		// SIGTERM each child — do NOT touch the persistence log.
		await Promise.all(entries.map((e) => e.rpc.stop()));

		if (this.broker) {
			await this.broker.stop();
			this.broker = null;
		}

		this.topology = null;
		this.correlationToTarget.clear();
		this.sessionDir = null;
		this.persistence = null;
	}

	private async teardownAll(): Promise<{ report: string; empty: boolean }> {
		const report = this.getCompletionReport();
		const xml = serializeGroupTorndown(report);

		for (const entry of this.entries) {
			if (this.persistence) {
				appendAgentRemoved(this.persistence, {
					id: entry.id,
					sessionFile: entry.sessionFile,
					sessionId: entry.sessionId,
				});
			}
		}

		// Swap entries out BEFORE stopping — prevents monitorExit from seeing the
		// SIGTERM exit code mid-teardown and firing spurious crash notifications
		// (mirrors teardownSingle).
		const entries = this.entries;
		this.entries = [];

		// Stop all children
		await Promise.all(entries.map((e) => e.rpc.stop()));

		// Stop broker
		if (this.broker) {
			await this.broker.stop();
			this.broker = null;
		}

		this.topology = null;
		this.correlationToTarget.clear();
		this.sessionDir = null;
		this.persistence = null;

		return { report: xml, empty: true };
	}

	private async teardownSingle(agentId: string): Promise<{ report: string; empty: boolean }> {
		const entryIdx = this.entries.findIndex((e) => e.id === agentId);
		if (entryIdx === -1) {
			throw new Error(`Unknown agent: "${agentId}"`);
		}

		const entry = this.entries[entryIdx];

		// Build single-agent teardown report before stopping. If the agent already
		// idled/failed on its own, the parent has already received the full
		// <agent_idle> notification — the teardown report stays slim and just
		// surfaces session_id + resurrection hint.
		const data: AgentCompleteData = {
			id: entry.id,
			status: entry.status.state === "failed" ? "failed" : "idle",
			output: entry.status.lastOutput,
			error: entry.status.state === "failed" ? (entry.status.lastError || entry.rpc.stderr || "Process crashed") : undefined,
			sessionId: entry.sessionId,
			alreadyNotified: entry.completionNotified,
		};
		const xml = serializeAgentTorndown(data);

		// Remove from entries before stopping — prevents monitorExit from
		// seeing the SIGTERM exit code and firing a spurious crash notification.
		this.entries.splice(entryIdx, 1);

		if (this.persistence) {
			appendAgentRemoved(this.persistence, {
				id: entry.id,
				sessionFile: entry.sessionFile,
				sessionId: entry.sessionId,
			});
		}

		// Stop the agent's RPC child
		await entry.rpc.stop();

		// Notify broker
		if (this.broker) {
			this.broker.agentRemoved(agentId);
		}

		// Update topology
		if (this.topology) {
			removeFromTopology(this.topology, agentId);
		}

		// Clean up correlation tracking for this agent
		for (const [corrId, target] of this.correlationToTarget) {
			if (target === agentId) {
				this.correlationToTarget.delete(corrId);
			}
		}

		// If no agents left, tear down infrastructure
		if (this.entries.length === 0) {
			if (this.broker) {
				await this.broker.stop();
				this.broker = null;
			}
			this.sessionDir = null;
			this.persistence = null;
			this.topology = null;
			this.correlationToTarget.clear();

			return { report: xml, empty: true };
		}

		return { report: xml, empty: false };
	}

	getBroker(): Broker | null {
		return this.broker;
	}

	/** Returns the live agent's id holding this session UUID, or undefined. */
	findLiveHolder(sessionId: string): string | undefined {
		return this.entries.find((e) => e.sessionId === sessionId)?.id;
	}

	/**
	 * Resolves a session UUID to a child session file path within this parent's
	 * sessions dir. Returns undefined if not found or the directory does not exist.
	 * Works whether or not subagent infrastructure has been initialized yet.
	 */
	resolveSessionFile(sessionId: string): string | undefined {
		let sessionsDir = this.sessionDir;
		if (!sessionsDir) {
			const parentSessionFile = this.opts.parentSessionFile;
			if (!parentSessionFile) return undefined;
			sessionsDir = getPersistencePaths(parentSessionFile).childSessionsDir;
		}
		if (!fs.existsSync(sessionsDir)) return undefined;
		try {
			const entries = fs.readdirSync(sessionsDir);
			// Match pi's session-file convention: `<timestamp>_<uuid>.jsonl`.
			// Stricter than `includes` so we don't accidentally return a sibling
			// `<timestamp>_<uuid>.subagents` directory or any unrelated file that
			// happens to contain the UUID as a substring.
			const suffix = `_${sessionId}.jsonl`;
			const match = entries.find((name) => name.endsWith(suffix));
			return match ? path.join(sessionsDir, match) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Resolves a session UUID to the original agent persona name (e.g. "scout"),
	 * by scanning the parent's raw lifecycle JSONL for an `agent_added` event
	 * with this sessionId. Works even after the agent has been torn down.
	 * Returns `undefined` if the parent has no persistence log, no matching
	 * record exists, or the record had no persona (default agent).
	 */
	findPersistedAgentName(sessionId: string): string | undefined {
		const parentSessionFile = this.opts.parentSessionFile;
		if (!parentSessionFile) return undefined;
		return findAgentRecordBySessionId(parentSessionFile, sessionId)?.agent;
	}

	// ─── Internal ────────────────────────────────────────────────────────

	private toRestoreSpec(agent: PersistedAgentRecord): AgentSpec {
		if (agent.kind === "fork") {
			return {
				kind: "fork",
				id: agent.id,
				task: agent.task,
				sessionFile: agent.sessionFile,
				resumeSessionFile: agent.sessionFile,
				// Restore the tool/skill restrictions captured at fork time.
				// Legacy records (written before these fields existed) fall back
				// to unrestricted — the old behavior.
				tools: agent.tools ?? [],
				skillPaths: agent.skillPaths ?? [],
				thinkingLevel: this.opts.pi.getThinkingLevel() as string,
			};
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

	private handleRpcEvent(entry: AgentEntry, event: any): void {
		if (event.type === "tool_execution_start") {
			entry.status.lastActivity = `${event.toolName}(${summarizeArgs(event.args)})`.replace(/[\r\n]+/g, " ");
			if (event.toolName === "subagent" || event.toolName === "fork") entry.status.hasSubgroup = true;
			if (event.toolName === "teardown") entry.status.hasSubgroup = false;
			this.opts.onUpdate(this);
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			if (msg.role === "assistant") {
				entry.status.usage.turns++;
				const usage = msg.usage;
				if (usage) {
					entry.status.usage.input += usage.input || 0;
					entry.status.usage.output += usage.output || 0;
					entry.status.usage.cacheRead += usage.cacheRead || 0;
					entry.status.usage.cacheWrite += usage.cacheWrite || 0;
					entry.status.usage.cost += usage.cost?.total || 0;
				}
				if (msg.model) entry.status.model = msg.model;

				// Context fill: sum input-side token types (non-cached + cache read + cache write).
				// Excludes output — those don't count against the window for this turn.
				entry.status.lastTurnInput = (usage?.input || 0)
					+ (usage?.cacheRead || 0) + (usage?.cacheWrite || 0);

				// Resolve context window on first model sighting
				if (entry.status.contextWindow === undefined && msg.model && this.opts.resolveContextWindow) {
					entry.status.contextWindow = this.opts.resolveContextWindow(msg.model);
				}

				// Capture last assistant text
				for (const part of msg.content ?? []) {
					if (part.type === "text") {
						entry.status.lastOutput = part.text;
					}
				}
				this.opts.onUpdate(this);
			}
		}

		if (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error") {
			if (entry.status.state === "running" && !entry.agentStartedSinceLastPrompt) {
				// Input handler blocked the prompt before the agent began processing.
				// Settle the entry as failed so the parent doesn't wait forever.
				this.settleFailed(entry, event.message);
			} else if (entry.status.state !== "running") {
				// Idle child received a blocked message — unblock any senders
				// waiting on it so they fail fast instead of hanging.
				this.broker?.agentIdled(entry.id);
			}
		}

		if (event.type === "agent_start") {
			if (entry.status.state !== "failed") {
				entry.status.state = "running";
				entry.agentStartedSinceLastPrompt = true;
				this.opts.onUpdate(this);
			}
		}

		if (event.type === "agent_end") {
			if (entry.status.state !== "failed") {
				// Inspect the final assistant message: if the run ended with
				// stopReason "error" (provider failure, exhausted retries, etc.)
				// the agent did NOT complete cleanly — surface it as a failure so
				// the parent gets the error instead of an empty <agent_idle>.
				const msgs: any[] = Array.isArray(event.messages) ? event.messages : [];
				let erroredMsg: any;
				for (let i = msgs.length - 1; i >= 0; i--) {
					if (msgs[i]?.role === "assistant") {
						if (msgs[i]?.stopReason === "error") erroredMsg = msgs[i];
						break;
					}
				}
				if (erroredMsg) {
					this.settleFailed(entry, erroredMsg.errorMessage || "Agent run ended with an error");
				} else {
					entry.status.state = "idle";
					// Reset so the next prompt to this agent starts clean.
					entry.agentStartedSinceLastPrompt = false;
					entry.status.lastActivity = undefined;
					// Unblock any blocking sends targeting this agent. The process is
					// still alive (it can be re-prompted), so treat like idle rather
					// than a crash that removes the agent from the broker.
					this.broker?.agentIdled(entry.id);
					this.opts.onUpdate(this);
					entry.completionNotified = true;
					this.opts.onAgentComplete(this, entry.id, this.allDone());
				}
			}
		}
	}

	/**
	 * Settle an entry as failed with the given error message. Used by both the
	 * agent_end error path and the error-notify-before-agent_start path — one
	 * business operation, one function.
	 */
	private settleFailed(entry: AgentEntry, errorMessage: string): void {
		entry.status.state = "failed";
		entry.status.lastError = errorMessage;
		entry.status.lastActivity = undefined;
		entry.agentStartedSinceLastPrompt = false;
		this.broker?.agentIdled(entry.id);
		this.opts.onUpdate(this);
		entry.completionNotified = true;
		this.opts.onAgentComplete(this, entry.id, this.allDone());
	}

	private monitorExit(entry: AgentEntry): void {
		const check = () => {
			if (!this.entries.includes(entry)) return; // entry was removed
			if (entry.rpc.exitCode !== null && entry.status.state !== "failed") {
				// Any exit is unexpected while the agent hasn't settled — including
				// exit code 0. Without this, a child that exits cleanly mid-task
				// stays "running" forever and await_agents never resolves.
				const settled = entry.status.state === "idle";
				if (entry.rpc.exitCode !== 0 || !settled) {
					entry.status.state = "failed";
					if (entry.rpc.exitCode === 0 && !entry.status.lastError) {
						entry.status.lastError = "Process exited unexpectedly";
					}
					entry.status.lastActivity = undefined;
					if (this.broker) {
						this.broker.agentCrashed(entry.id);
					}
					this.opts.onUpdate(this);
					entry.completionNotified = true;
					this.opts.onAgentComplete(this, entry.id, this.allDone());
				}
			}
		};

		// Poll for exit (RPC child doesn't expose an exit event directly)
		const interval = setInterval(() => {
			check();
			if (!this.entries.includes(entry) || entry.rpc.exitCode !== null) {
				clearInterval(interval);
			}
		}, 500);
	}

	private allDone(): boolean {
		const allSettled = this.entries.every(
			(e) => e.status.state === "idle" || e.status.state === "failed",
		);
		return allSettled && (this.broker?.isQuiet() ?? true);
	}

	private handleParentMessage(msg: BrokerResponse): void {
		if (msg.type === "message") {
			const xml = serializeAgentMessage({
				from: msg.from,
				content: msg.message,
				correlationId: msg.correlationId,
				responseExpected: msg.responseExpected ?? false,
			});

			this.opts.onParentMessage(xml, {
				correlationId: msg.correlationId,
				responseExpected: msg.responseExpected ?? false,
			});
		}
	}

	private aggregateUsage(): { input: number; output: number; cost: number } {
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const e of this.entries) {
			input += e.status.usage.input + e.status.usage.cacheRead + e.status.usage.cacheWrite;
			output += e.status.usage.output;
			cost += e.status.usage.cost;
		}
		return { input, output, cost };
	}

	/** Set an agent's state to "waiting" (called by broker on blocking send start) */
	private setAgentWaiting(agentId: string, correlationId: string, targetId: string): void {
		const entry = this.entries.find((e) => e.id === agentId);
		if (entry && entry.status.state !== "failed") {
			entry.status.state = "waiting";
			entry.status.pendingCorrelations.push(correlationId);
			this.correlationToTarget.set(correlationId, targetId);
			entry.status.waitingFor.push(targetId);
			this.opts.onUpdate(this);
		}
	}

	/** Clear waiting state when response arrives (called by broker on blocking send end) */
	private clearAgentWaiting(agentId: string, correlationId: string): void {
		const entry = this.entries.find((e) => e.id === agentId);
		if (entry) {
			entry.status.pendingCorrelations = entry.status.pendingCorrelations.filter(
				(c) => c !== correlationId,
			);
			const target = this.correlationToTarget.get(correlationId);
			if (target) {
				const idx = entry.status.waitingFor.indexOf(target);
				if (idx !== -1) entry.status.waitingFor.splice(idx, 1);
				this.correlationToTarget.delete(correlationId);
			}
			if (entry.status.pendingCorrelations.length === 0 && entry.status.state === "waiting") {
				entry.status.state = "running";
			}
			this.opts.onUpdate(this);
		}
	}
}

function summarizeArgs(args: Record<string, any>): string {
	if (!args) return "";
	if (args.command) {
		const cmd = String(args.command).replace(/[\r\n\t]+/g, " ").replace(/  +/g, " ").trim();
		return cmd.length > 40 ? cmd.slice(0, 40) + "…" : cmd;
	}
	if (args.path) return String(args.path);
	const keys = Object.keys(args);
	if (keys.length === 0) return "";
	return keys.slice(0, 2).join(", ");
}
