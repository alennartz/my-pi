/**
 * Group lifecycle management.
 *
 * Spawns pi --mode rpc child processes, manages per-agent state,
 * subscribes to RPC event streams for widget updates, and coordinates
 * broker startup/teardown.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { RpcChild } from "./rpc-child.js";
import { Broker } from "./broker.js";
import { type AgentConfig, buildAgentArgs } from "./agents.js";
import { type Topology, buildTopology } from "./channels.js";
import {
	serializeSubagentIdentity,
	serializeAgentMessage,
	type GroupCompleteData,
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
}

interface AgentEntry {
	id: string;
	agentDef?: string;
	task: string;
	channels: string[];
	rpc: RpcChild;
	status: AgentStatus;
}

export interface GroupManagerOptions {
	pi: ExtensionAPI;
	agents: Array<{ id: string; agent?: string; task: string; channels?: string[] }>;
	agentConfigs: AgentConfig[];
	topology: Topology;
	skillPaths: Map<string, string[]>;
	cwd: string;
	onUpdate: () => void;
	onGroupIdle: () => void;
	onAgentComplete: (agentId: string) => void;
}

export class GroupManager {
	private entries: AgentEntry[] = [];
	private broker: Broker | null = null;
	private opts: GroupManagerOptions;
	private destroyed = false;

	constructor(opts: GroupManagerOptions) {
		this.opts = opts;
	}

	getAgentStatuses(): AgentStatus[] {
		return this.entries.map((e) => e.status);
	}

	getAgentStatus(agentId: string): AgentStatus | undefined {
		return this.entries.find((e) => e.id === agentId)?.status;
	}

	getCompletionReport(): GroupCompleteData {
		const agents: AgentCompleteData[] = this.entries.map((e) => ({
			id: e.id,
			status: e.status.state === "failed" ? "failed" : "idle",
			output: e.status.lastOutput,
			error: e.status.state === "failed" ? (e.rpc.stderr || "Process crashed") : undefined,
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

	async start(): Promise<string> {
		const { pi, agents, agentConfigs, topology, skillPaths, cwd } = this.opts;

		// Start broker
		this.broker = new Broker({
			topology,
			onParentMessage: (msg) => this.handleParentMessage(msg),
		});
		await this.broker.start();

		// Build and spawn each agent
		for (const agentSpec of agents) {
			const agentConfig = agentSpec.agent ? agentConfigs.find((a) => a.name === agentSpec.agent) : undefined;
			const channels = agentSpec.channels ?? [];
			const allChannels = [...channels, "parent"];

			// Build identity XML for system prompt
			const peers = agents
				.filter((a) => a.id !== agentSpec.id)
				.filter((a) => allChannels.includes(a.id) || agentSpec.id === "parent")
				.map((a) => {
					const peerConfig = a.agent ? agentConfigs.find((c) => c.name === a.agent) : undefined;
					return {
						id: a.id,
						description: peerConfig?.description,
						isDefault: !a.agent,
					};
				});

			// Always add parent as a peer
			peers.push({
				id: "parent",
				description:
					"The orchestrating agent that spawned this group. It can see all agents' status and decides when the group is done. Send it questions when you need human-level judgment or decisions that affect the whole group.",
			});

			const identityXml = serializeSubagentIdentity({
				id: agentSpec.id,
				task: agentSpec.task,
				peers,
			});

			// Build args
			const agentSkillPaths = skillPaths.get(agentSpec.id) ?? [];
			const baseArgs = buildAgentArgs(agentConfig, agentSkillPaths);
			const args = [...baseArgs, "--append-system-prompt", identityXml];

			// PI_SUBAGENT env var with identity
			const envPayload = JSON.stringify({
				id: agentSpec.id,
				channels: allChannels,
				task: agentSpec.task,
				brokerSocket: this.broker.socketPath,
			});

			const rpc = new RpcChild({
				cwd,
				env: { PI_SUBAGENT: envPayload },
				args,
			});

			const status: AgentStatus = {
				id: agentSpec.id,
				state: "running",
				agentDef: agentSpec.agent,
				task: agentSpec.task,
				channels: allChannels,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				pendingCorrelations: [],
			};

			const entry: AgentEntry = {
				id: agentSpec.id,
				agentDef: agentSpec.agent,
				task: agentSpec.task,
				channels: allChannels,
				rpc,
				status,
			};

			this.entries.push(entry);

			// Subscribe to RPC events
			rpc.onEvent((event) => this.handleRpcEvent(entry, event));
		}

		// Start all RPC children
		await Promise.all(this.entries.map((e) => e.rpc.start()));

		// Send initial task prompts
		for (const entry of this.entries) {
			entry.rpc.prompt(`Task: ${entry.task}`).catch(() => {
				// Process may have died
			});
		}

		// Monitor for process exits
		for (const entry of this.entries) {
			this.monitorExit(entry);
		}

		// Build acknowledgment
		const lines = [`Group spawned: ${agents.length} agents`];
		for (const a of agents) {
			const ch = a.channels?.length ? a.channels.join(", ") : "(none)";
			lines.push(`- ${a.id}: task="${a.task}", channels=[${ch}, parent]`);
		}
		lines.push("Use check_status to monitor progress. Send messages to any agent via send.");
		return lines.join("\n");
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;

		// Stop all children
		await Promise.all(this.entries.map((e) => e.rpc.stop()));

		// Stop broker
		if (this.broker) {
			await this.broker.stop();
			this.broker = null;
		}
	}

	getBroker(): Broker | null {
		return this.broker;
	}

	// ─── Internal ────────────────────────────────────────────────────────

	private handleRpcEvent(entry: AgentEntry, event: any): void {
		if (this.destroyed) return;

		if (event.type === "tool_execution_start") {
			entry.status.lastActivity = `${event.toolName}(${summarizeArgs(event.args)})`;
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
				this.opts.onAgentComplete(entry.id);
				this.checkGroupIdle();
			}
		}
	}

	private monitorExit(entry: AgentEntry): void {
		const check = () => {
			if (this.destroyed) return;
			if (entry.rpc.exitCode !== null && entry.status.state !== "failed") {
				if (entry.rpc.exitCode !== 0) {
					entry.status.state = "failed";
					entry.status.lastActivity = undefined;
					if (this.broker) {
						this.broker.agentDied(entry.id);
					}
					this.opts.onUpdate();
					this.opts.onAgentComplete(entry.id);
					this.checkGroupIdle();
				}
			}
		};

		// Poll for exit (RPC child doesn't expose an exit event directly)
		const interval = setInterval(() => {
			check();
			if (entry.rpc.exitCode !== null || this.destroyed) {
				clearInterval(interval);
			}
		}, 500);
	}

	private checkGroupIdle(): void {
		if (this.destroyed) return;

		const allDone = this.entries.every(
			(e) => e.status.state === "idle" || e.status.state === "failed",
		);

		if (allDone && this.broker?.isQuiet()) {
			this.opts.onGroupIdle();
		}
	}

	private handleParentMessage(msg: BrokerResponse): void {
		if (msg.type === "message") {
			// Deliver to parent's conversation via sendMessage
			const xml = serializeAgentMessage({
				from: msg.from,
				content: msg.message,
				correlationId: msg.correlationId,
				responseExpected: msg.responseExpected ?? false,
			});

			this.opts.pi.sendMessage(
				{
					customType: "subagents",
					content: xml,
					display: true,
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		}
	}

	private aggregateUsage(): { input: number; output: number; cost: number } {
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const e of this.entries) {
			input += e.status.usage.input;
			output += e.status.usage.output;
			cost += e.status.usage.cost;
		}
		return { input, output, cost };
	}

	/** Set an agent's state to "waiting" (used by send tool for blocking sends) */
	setAgentWaiting(agentId: string, correlationId: string): void {
		const entry = this.entries.find((e) => e.id === agentId);
		if (entry && entry.status.state !== "failed") {
			entry.status.state = "waiting";
			entry.status.pendingCorrelations.push(correlationId);
			this.opts.onUpdate();
		}
	}

	/** Clear waiting state when response arrives */
	clearAgentWaiting(agentId: string, correlationId: string): void {
		const entry = this.entries.find((e) => e.id === agentId);
		if (entry) {
			entry.status.pendingCorrelations = entry.status.pendingCorrelations.filter(
				(c) => c !== correlationId,
			);
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
		const cmd = String(args.command);
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
