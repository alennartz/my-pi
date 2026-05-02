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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { RpcChild } from "./rpc-child.js";
import { Broker } from "./broker.js";
import { type AgentConfig, type AgentSpec, type ForkAgentSpec, buildAgentArgs, buildForkArgs } from "./agents.js";
import { ensurePersistence, appendAgentAdded, appendAgentRemoved, loadPersistedAgents, getPersistencePaths, type PersistencePaths, type PersistedAgentRecord } from "./persistence.js";
import { type Topology, buildTopology, addToTopology, removeFromTopology } from "./channels.js";
import {
	serializeSubagentIdentity,
	serializeAgentMessage,
	serializeGroupComplete,
	serializeAgentComplete,
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
}

export interface SubagentManagerOptions {
	pi: ExtensionAPI;
	cwd: string;
	parentSessionFile?: string;
	skillPaths: Map<string, string[]>;
	resolveContextWindow: (modelId: string) => number | undefined;
	onUpdate: () => void;
	onAgentComplete: (agentId: string, allDone: boolean) => void;
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

	private getCompletionReport(): ActiveAgentsCompleteData {
		const agents: AgentCompleteData[] = this.entries.map((e) => ({
			id: e.id,
			status: e.status.state === "failed" ? "failed" : "idle",
			output: e.status.lastOutput,
			error: e.status.state === "failed" ? (e.rpc.stderr || "Process crashed") : undefined,
			sessionId: e.sessionId,
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

			// Build identity XML for system prompt
			const allAgents = [...this.entries.map((e) => ({ id: e.id, kind: "agent" as const, task: e.task, agentDef: e.agentDef })), ...agents];
			const peers = allAgents
				.filter((a) => a.id !== agentSpec.id)
				.filter((a) => allChannels.includes(a.id) || agentSpec.id === "parent")
				.map((a) => {
					const peerConfig = "agentDef" in a && a.agentDef
						? agentConfigs.find((c) => c.name === a.agentDef)
						: a.kind === "agent" && "agent" in a && (a as any).agent
							? agentConfigs.find((c) => c.name === (a as any).agent)
							: undefined;
					return {
						id: a.id,
						description: peerConfig?.description,
						isDefault: a.kind === "agent" ? !("agent" in a && (a as any).agent) && !("agentDef" in a && a.agentDef) : false,
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
				const agentSkillPaths = skillPaths.get(agentSpec.id) ?? [];
				args = buildAgentArgs(
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

			const rpc = new RpcChild({
				cwd,
				env: { PI_PARENT_LINK: envPayload },
				args,
			});

			const status: AgentStatus = {
				id: agentSpec.id,
				state: "running",
				agentDef: agentSpec.kind === "agent" ? agentSpec.agent : undefined,
				task: agentSpec.task,
				channels: allChannels,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				pendingCorrelations: [],
				lastTurnInput: 0,
				hasSubgroup: false,
				waitingFor: [],
			};

			const entry: AgentEntry = {
				id: agentSpec.id,
				agentDef: agentSpec.kind === "agent" ? agentSpec.agent : undefined,
				task: agentSpec.task,
				channels: allChannels,
				rpc,
				status,
				kind: agentSpec.kind,
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

		this.persistence = persisted.paths;
		this.sessionDir = persisted.paths.childSessionsDir;
		this.restoring = true;
		try {
			const restored = persisted.agents.map((agent) => this.toRestoreSpec(agent));
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

	private async teardownAll(): Promise<{ report: string; empty: boolean }> {
		const report = this.getCompletionReport();
		const xml = serializeGroupComplete(report);

		for (const entry of this.entries) {
			if (this.persistence) {
				appendAgentRemoved(this.persistence, {
					id: entry.id,
					sessionFile: entry.sessionFile,
					sessionId: entry.sessionId,
				});
			}
		}

		// Stop all children
		await Promise.all(this.entries.map((e) => e.rpc.stop()));

		// Stop broker
		if (this.broker) {
			await this.broker.stop();
			this.broker = null;
		}


		this.entries = [];
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

		// Build single-agent report before stopping
		const data: AgentCompleteData = {
			id: entry.id,
			status: entry.status.state === "failed" ? "failed" : "idle",
			output: entry.status.lastOutput,
			error: entry.status.state === "failed" ? (entry.rpc.stderr || "Process crashed") : undefined,
			sessionId: entry.sessionId,
		};
		const xml = serializeAgentComplete(data);

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
			const match = entries.find((name) => name.includes(sessionId));
			return match ? path.join(sessionsDir, match) : undefined;
		} catch {
			return undefined;
		}
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
				tools: [],
				skillPaths: [],
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
		};
	}

	private handleRpcEvent(entry: AgentEntry, event: any): void {
		if (event.type === "tool_execution_start") {
			entry.status.lastActivity = `${event.toolName}(${summarizeArgs(event.args)})`.replace(/[\r\n]+/g, " ");
			if (event.toolName === "subagent" || event.toolName === "fork") entry.status.hasSubgroup = true;
			if (event.toolName === "teardown") entry.status.hasSubgroup = false;
			this.opts.onUpdate();
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
				this.opts.onUpdate();
			}
		}

		if (event.type === "agent_start") {
			if (entry.status.state !== "failed") {
				entry.status.state = "running";
				this.opts.onUpdate();
			}
		}

		if (event.type === "agent_end") {
			if (entry.status.state !== "failed") {
				entry.status.state = "idle";
				entry.status.lastActivity = undefined;
				this.opts.onUpdate();
				this.opts.onAgentComplete(entry.id, this.allDone());
			}
		}
	}

	private monitorExit(entry: AgentEntry): void {
		const check = () => {
			if (!this.entries.includes(entry)) return; // entry was removed
			if (entry.rpc.exitCode !== null && entry.status.state !== "failed") {
				if (entry.rpc.exitCode !== 0) {
					entry.status.state = "failed";
					entry.status.lastActivity = undefined;
					if (this.broker) {
						this.broker.agentCrashed(entry.id);
					}
					this.opts.onUpdate();
					this.opts.onAgentComplete(entry.id, this.allDone());
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
			this.opts.onUpdate();
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
			this.opts.onUpdate();
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

function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
