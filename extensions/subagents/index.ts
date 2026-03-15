/**
 * Subagents Extension — Entry point.
 *
 * Detects role via PI_SUBAGENT env var:
 * - Absent: root agent. Starts broker, registers all tools.
 * - Present: child agent. Connects to parent's broker, registers all tools.
 *
 * Both roles register the same five tools: subagent, send, respond,
 * check_status, teardown_group. Children can spawn sub-groups (recursive).
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	type AgentScope,
	type AgentConfig,
	discoverAgents,
	resolveSkillPaths,
	formatAgentList,
} from "./agents.js";
import { buildTopology, validateTopology } from "./channels.js";
import { GroupManager } from "./group.js";
import { renderGroupWidget } from "./widget.js";
import {
	serializeAgentComplete,
	serializeGroupIdle,
	serializeGroupComplete,
	serializeAgentMessage,
	type BrokerRequest,
	type BrokerResponse,
	type AgentCompleteData,
} from "./messages.js";

// ─── Child identity from env var ─────────────────────────────────────────────

interface ChildIdentity {
	id: string;
	channels: string[];
	task: string;
	brokerSocket: string;
}

function getChildIdentity(): ChildIdentity | null {
	const raw = process.env.PI_SUBAGENT;
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// ─── Broker socket client (used by children and parent for send/respond) ─────

class BrokerClient {
	private socket: net.Socket | null = null;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private waiters: Array<(msg: BrokerResponse) => void> = [];
	private correlationWaiters = new Map<string, (msg: BrokerResponse) => void>();
	private messageHandler: ((msg: BrokerResponse) => void) | null = null;

	async connect(socketPath: string, agentId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection(socketPath, () => {
				this.write({ type: "register", agentId });
				// Wait for registered response
				this.waitForNext().then((msg) => {
					if (msg.type === "registered") resolve();
					else reject(new Error(`Expected 'registered', got '${msg.type}'`));
				});
			});

			this.socket.on("data", (chunk: Buffer) => {
				this.buffer += this.decoder.write(chunk);
				while (true) {
					const idx = this.buffer.indexOf("\n");
					if (idx === -1) break;
					let line = this.buffer.slice(0, idx);
					this.buffer = this.buffer.slice(idx + 1);
					if (line.endsWith("\r")) line = line.slice(0, -1);
					if (!line) continue;

					let parsed: BrokerResponse;
					try {
						parsed = JSON.parse(line);
					} catch {
						continue;
					}

					// Unsolicited agent messages always go to the message handler,
					// bypassing the waiter queue. Only solicited responses (send_ack,
					// response, error, registered) are dispatched to waiters.
					if (parsed.type === "message") {
						if (this.messageHandler) {
							this.messageHandler(parsed);
						}
						continue;
					}

					// Correlation-based dispatch for response/error with correlationId
					if ((parsed.type === "response" || parsed.type === "error") && parsed.correlationId) {
						const waiter = this.correlationWaiters.get(parsed.correlationId);
						if (waiter) {
							this.correlationWaiters.delete(parsed.correlationId);
							waiter(parsed);
							continue;
						}
					}

					// Check waiters for solicited responses
					if (this.waiters.length > 0) {
						const waiter = this.waiters.shift()!;
						waiter(parsed);
						continue;
					}

					// Fallback: dispatch to message handler
					if (this.messageHandler) {
						this.messageHandler(parsed);
					}
				}
			});

			this.socket.on("error", (err) => {
				reject(err);
			});

			this.socket.on("close", () => {
				// Reject all pending waiters on unexpected disconnect
				const error: BrokerResponse = { type: "error", error: "Broker connection lost" };
				for (const waiter of this.waiters) {
					waiter(error);
				}
				this.waiters = [];
				for (const [, waiter] of this.correlationWaiters) {
					waiter(error);
				}
				this.correlationWaiters.clear();
			});
		});
	}

	onMessage(handler: (msg: BrokerResponse) => void): void {
		this.messageHandler = handler;
	}

	write(msg: BrokerRequest): void {
		if (this.socket?.writable) {
			this.socket.write(JSON.stringify(msg) + "\n");
		}
	}

	waitForNext(): Promise<BrokerResponse> {
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	waitForResponse(correlationId: string): Promise<BrokerResponse> {
		return new Promise((resolve) => {
			this.correlationWaiters.set(correlationId, resolve);
		});
	}

	/**
	 * Send a request and wait for the next response (send_ack, response, or error).
	 */
	async sendAndWait(msg: BrokerRequest): Promise<BrokerResponse> {
		this.write(msg);
		return this.waitForNext();
	}

	disconnect(): void {
		this.socket?.destroy();
		this.socket = null;
	}
}

// ─── Main extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const childIdentity = getChildIdentity();

	// Shared state
	let activeGroup: GroupManager | null = null;
	let brokerClient: BrokerClient | null = null;

	// ─── Notification queue (root agent only) ────────────────────────────
	//
	// Instead of delivering each agent notification immediately via
	// pi.sendMessage(), we accumulate them in an internal queue and flush
	// as a single combined message. This avoids:
	//   - Consecutive user messages (out-of-distribution for most LLMs)
	//   - Stale stragglers draining after teardown
	//   - Preemption of parent tool calls
	//
	// Flush happens on agent_end (parent finished its turn) or via a
	// debounce timer when the parent is idle.

	const notificationQueue: string[] = [];
	let parentBusy = false;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	function queueNotification(xml: string): void {
		notificationQueue.push(xml);
		if (!parentBusy) {
			// Parent is idle — debounce briefly to batch rapid-fire notifications
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = setTimeout(flushNotifications, 100);
		}
		// If parent is busy, flush will happen on agent_end
	}

	function flushNotifications(): void {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (notificationQueue.length === 0) return;

		const combined = notificationQueue.splice(0).join("\n");
		pi.sendMessage(
			{ customType: "subagents", content: combined, display: true },
			{ triggerTurn: true },
		);
	}

	function clearNotificationQueue(): void {
		notificationQueue.length = 0;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	}

	if (!childIdentity) {
		pi.on("agent_start", async () => {
			parentBusy = true;
		});

		pi.on("agent_end", async () => {
			parentBusy = false;
			flushNotifications();
		});
	}

	// ─── Child setup ─────────────────────────────────────────────────────

	if (childIdentity) {
		brokerClient = new BrokerClient();

		// Connect to parent's broker on session start
		pi.on("session_start", async (_event, _ctx) => {
			try {
				await brokerClient!.connect(childIdentity.brokerSocket, childIdentity.id);

				// Handle incoming messages from broker
				brokerClient!.onMessage((msg) => {
					if (msg.type === "message") {
						const xml = serializeAgentMessage({
							from: msg.from,
							content: msg.message,
							correlationId: msg.correlationId,
							responseExpected: msg.responseExpected ?? false,
						});
						pi.sendMessage(
							{
								customType: "subagents",
								content: xml,
								display: true,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					}
				});
			} catch (err) {
				// Broker connection failed — agent can still function but can't communicate
				console.error(`[subagent:${childIdentity.id}] Failed to connect to broker: ${err}`);
			}
		});
	}

	// ─── Tool: subagent ──────────────────────────────────────────────────

	const AgentItem = Type.Object({
		id: Type.String({ description: "Unique identifier for this agent within the group" }),
		agent: Type.Optional(Type.String({ description: "Agent definition name (omit for default agent)" })),
		task: Type.String({ description: "Task description for this agent" }),
		channels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Peer agent ids this agent can send to (agent-to-agent only; parent is always allowed)",
			}),
		),
	});

	const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
		description: 'Where to discover agent .md files. Default: "user".',
		default: "user",
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent Group",
		description: "Spawn a group of specialized subagents with channel-based inter-agent communication.",
		promptGuidelines: [
			"Spawns a group of agents that run in parallel with isolated contexts. Non-blocking — returns immediately with an acknowledgment. Live status shown in the widget.",
			"One active group at a time. Each agent gets its own pi process. Agents communicate via the send/respond tools using channels declared at spawn time.",
			"Parent (you) is auto-injected into every agent's channel list. The channels field governs agent-to-agent peer communication only.",
			"Monitor progress via check_status. When all agents are done, you'll receive a <group_idle> notification. Call teardown_group to end the group.",
		],
		parameters: Type.Object({
			agents: Type.Array(AgentItem, { description: "Agents to spawn in this group" }),
			agentScope: Type.Optional(AgentScopeSchema),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (activeGroup) {
				throw new Error("A group is already active. Call teardown_group first.");
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const allAgentConfigs = discovery.agents;

			// Validate agent definitions exist
			for (const a of params.agents) {
				if (a.agent) {
					const found = allAgentConfigs.find((c) => c.name === a.agent);
					if (!found) {
						const available = formatAgentList(allAgentConfigs, 10);
						throw new Error(
							`Unknown agent definition "${a.agent}". Available: ${available.text}`,
						);
					}
				}
			}

			// Validate unique ids
			const ids = params.agents.map((a) => a.id);
			const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
			if (dupes.length > 0) {
				throw new Error(`Duplicate agent ids: ${dupes.join(", ")}`);
			}

			// Validate topology
			const topoError = validateTopology(params.agents);
			if (topoError) {
				throw new Error(`Invalid topology: ${topoError}`);
			}

			const topology = buildTopology(params.agents);

			// Resolve skill paths for agents that declare skills
			const commands = pi.getCommands();
			const skillPathsMap = new Map<string, string[]>();
			for (const a of params.agents) {
				const agentConfig = a.agent ? allAgentConfigs.find((c) => c.name === a.agent) : undefined;
				if (agentConfig?.skills) {
					try {
						const paths = resolveSkillPaths(agentConfig.skills, commands);
						skillPathsMap.set(a.id, paths);
					} catch (err: any) {
						throw new Error(`Failed to resolve skills for agent "${a.id}": ${err.message}`);
					}
				}
			}

			// Confirm project agents if needed
			if ((agentScope === "project" || agentScope === "both") && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
				const projectAgentNames = new Set<string>();
				for (const a of params.agents) {
					if (a.agent) {
						const config = allAgentConfigs.find((c) => c.name === a.agent);
						if (config?.source === "project") projectAgentNames.add(config.name);
					}
				}
				if (projectAgentNames.size > 0) {
					const names = Array.from(projectAgentNames).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						};
					}
				}
			}

			// Create and start group
			const group = new GroupManager({
				pi,
				agents: params.agents,
				agentConfigs: allAgentConfigs,
				topology,
				skillPaths: skillPathsMap,
				cwd: ctx.cwd,
				onUpdate: () => {
					const statuses = group.getAgentStatuses();
					const lines = renderGroupWidget(statuses, ctx.ui.theme.fg.bind(ctx.ui.theme));
					ctx.ui.setWidget("subagents", lines);
				},
				onGroupIdle: () => {
					const statuses = group.getAgentStatuses();
					const agents: AgentCompleteData[] = statuses.map((s) => ({
						id: s.id,
						status: s.state === "failed" ? "failed" : "idle",
						output: s.lastOutput,
						error: s.state === "failed" ? "Process crashed" : undefined,
					}));
					const usage = aggregateUsage(statuses);
					const xml = serializeGroupIdle({ agents, usage });
					queueNotification(xml);
				},
				onAgentComplete: (agentId) => {
					const status = group.getAgentStatus(agentId);
					if (!status) return;
					const data: AgentCompleteData = {
						id: agentId,
						status: status.state === "failed" ? "failed" : "idle",
						output: status.lastOutput,
						error: status.state === "failed" ? "Process crashed" : undefined,
					};
					const xml = serializeAgentComplete(data);
					queueNotification(xml);
				},
				onParentMessage: (xml) => {
					queueNotification(xml);
				},
			});

			activeGroup = group;
			const ack = await group.start();

			// Connect parent's broker client eagerly — the broker is running
			// now, so we can connect immediately. This avoids a lazy-init race
			// when multiple send tool calls execute concurrently.
			const broker = group.getBroker();
			if (broker) {
				parentBrokerClient = new BrokerClient();
				await parentBrokerClient.connect(broker.socketPath, "parent");
			}

			return {
				content: [{ type: "text", text: ack }],
			};
		},
	});

	// ─── Tool: send ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "send",
		label: "Send Message",
		description: "Send a message to another agent in the group.",
		promptGuidelines: [
			"Fire-and-forget by default: sends the message and returns immediately. The target agent will receive it as an <agent_message> block.",
			"Set expectResponse=true for blocking sends: the tool call stays open until the target calls respond. Use for synchronous coordination (e.g., asking a question and waiting for the answer).",
			"For scatter-gather: call send(expectResponse=true) to multiple agents in the same turn. Each returns when its target responds.",
			"Channel enforcement: you can only send to agents in your channel list. Parent is always allowed.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Target agent id or 'parent'" }),
			message: Type.String({ description: "Message content" }),
			expectResponse: Type.Optional(
				Type.Boolean({ description: "Wait for a response (blocking). Default: false.", default: false }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const from = childIdentity?.id ?? "parent";
			const client = childIdentity ? brokerClient : activeGroup?.getBroker() ? getParentBrokerClient() : null;

			if (!client && !activeGroup) {
				throw new Error("No active group. Spawn a group first with the subagent tool.");
			}

			const correlationId = params.expectResponse ? crypto.randomUUID() : undefined;

			// For parent sending to agents, write directly to broker
			if (!childIdentity && activeGroup) {
				if (!parentBrokerClient) throw new Error("Broker client not connected");

				const resp = await parentBrokerClient.sendAndWait({
					type: "send",
					from: "parent",
					to: params.to,
					message: params.message,
					correlationId,
					expectResponse: params.expectResponse,
				});

				if (resp.type === "error") {
					throw new Error(resp.error);
				}

				if (params.expectResponse && correlationId) {
					// Wait for the response matched by correlation ID
					const responseMsg = await parentBrokerClient.waitForResponse(correlationId);
					if (responseMsg.type === "response") {
						return {
							content: [{ type: "text", text: responseMsg.message }],
						};
					} else if (responseMsg.type === "error") {
						throw new Error(responseMsg.error);
					}
					return {
						content: [{ type: "text", text: `Unexpected response type: ${responseMsg.type}` }],
					};
				}

				return {
					content: [{ type: "text", text: `Message sent to ${params.to}.` }],
				};
			}

			// Child path: use brokerClient
			if (!brokerClient) {
				throw new Error("Not connected to broker");
			}

			const resp = await brokerClient.sendAndWait({
				type: "send",
				from,
				to: params.to,
				message: params.message,
				correlationId,
				expectResponse: params.expectResponse,
			});

			if (resp.type === "error") {
				throw new Error(resp.error);
			}

			if (params.expectResponse && correlationId) {
				// Wait for the response matched by correlation ID
				const responseMsg = await brokerClient.waitForResponse(correlationId);

				if (responseMsg.type === "response") {
					return {
						content: [{ type: "text", text: responseMsg.message }],
					};
				} else if (responseMsg.type === "error") {
					throw new Error(responseMsg.error);
				}
				return {
					content: [{ type: "text", text: `Unexpected response type: ${responseMsg.type}` }],
				};
			}

			return {
				content: [{ type: "text", text: `Message sent to ${params.to}.` }],
			};
		},
	});

	// ─── Tool: respond ───────────────────────────────────────────────────

	pi.registerTool({
		name: "respond",
		label: "Respond",
		description: "Respond to a blocking message from another agent.",
		promptGuidelines: [
			'When you receive an <agent_message> with response_expected="true", you MUST call respond with the correlation_id from that message.',
			"The response is delivered back to the sender, unblocking their send tool call.",
		],
		parameters: Type.Object({
			correlationId: Type.String({ description: "The correlation_id from the incoming agent_message" }),
			message: Type.String({ description: "Response content" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const from = childIdentity?.id ?? "parent";
			const client = childIdentity ? brokerClient : parentBrokerClient;

			if (!client) {
				throw new Error("Not connected to broker");
			}

			const resp = await client.sendAndWait({
				type: "respond",
				from,
				correlationId: params.correlationId,
				message: params.message,
			});

			if (resp.type === "error") {
				throw new Error(resp.error);
			}

			return {
				content: [{ type: "text", text: "Response sent." }],
			};
		},
	});

	// ─── Tool: check_status ──────────────────────────────────────────────

	pi.registerTool({
		name: "check_status",
		label: "Check Status",
		description: "Query agent status. Omit agent for group summary.",
		promptGuidelines: [
			"Returns current state, activity, usage stats, and pending correlations for one or all agents.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent id to query. Omit for group summary." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!activeGroup) {
				throw new Error("No active group.");
			}

			if (params.agent) {
				const status = activeGroup.getAgentStatus(params.agent);
				if (!status) {
					throw new Error(`Unknown agent: "${params.agent}"`);
				}
				return {
					content: [{ type: "text", text: formatAgentStatusDetail(status) }],
				};
			}

			const statuses = activeGroup.getAgentStatuses();
			const lines = statuses.map(formatAgentStatusSummary);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		},
	});

	// ─── Tool: teardown_group ────────────────────────────────────────────

	pi.registerTool({
		name: "teardown_group",
		label: "Teardown Group",
		description: "End the current agent group. Kills all agent processes and delivers a final summary.",
		promptGuidelines: [
			"Call teardown_group to end the current agent group. Kills all agent processes and delivers a final summary with per-agent output and usage.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!activeGroup) {
				throw new Error("No active group to teardown.");
			}

			const report = activeGroup.getCompletionReport();
			const xml = serializeGroupComplete(report);

			await activeGroup.destroy();

			// Disconnect parent broker client
			if (parentBrokerClient) {
				parentBrokerClient.disconnect();
				parentBrokerClient = null;
			}

			activeGroup = null;
			clearNotificationQueue();
			ctx.ui.setWidget("subagents", undefined as any);

			return {
				content: [{ type: "text", text: `Group terminated.\n\n${xml}` }],
			};
		},
	});

	// ─── Parent broker client (lazy init) ────────────────────────────────

	let parentBrokerClient: BrokerClient | null = null;

	function getParentBrokerClient(): BrokerClient | null {
		return parentBrokerClient;
	}

	// ─── Cleanup on shutdown ─────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		clearNotificationQueue();
		if (activeGroup) {
			await activeGroup.destroy();
			activeGroup = null;
		}
		if (parentBrokerClient) {
			parentBrokerClient.disconnect();
			parentBrokerClient = null;
		}
		if (brokerClient) {
			brokerClient.disconnect();
			brokerClient = null;
		}
	});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAgentStatusSummary(s: import("./group.js").AgentStatus): string {
	const icon = { running: "⏳", idle: "✓", failed: "✗", waiting: "⏸" }[s.state];
	const usage = s.usage.cost > 0 ? ` ($${s.usage.cost.toFixed(4)})` : "";
	return `${icon} ${s.id}: ${s.state}${s.lastActivity ? ` — ${s.lastActivity}` : ""}${usage}`;
}

function formatAgentStatusDetail(s: import("./group.js").AgentStatus): string {
	const lines = [
		`Agent: ${s.id}`,
		`State: ${s.state}`,
		`Task: ${s.task}`,
		`Channels: ${s.channels.join(", ")}`,
	];
	if (s.agentDef) lines.push(`Agent definition: ${s.agentDef}`);
	if (s.model) lines.push(`Model: ${s.model}`);
	if (s.lastActivity) lines.push(`Last activity: ${s.lastActivity}`);
	if (s.lastOutput) {
		const preview = s.lastOutput.length > 200 ? s.lastOutput.slice(0, 200) + "..." : s.lastOutput;
		lines.push(`Last output: ${preview}`);
	}
	lines.push(`Usage: ↑${s.usage.input} ↓${s.usage.output} $${s.usage.cost.toFixed(4)} (${s.usage.turns} turns)`);
	if (s.pendingCorrelations.length > 0) {
		lines.push(`Pending correlations: ${s.pendingCorrelations.join(", ")}`);
	}
	return lines.join("\n");
}

function aggregateUsage(statuses: import("./group.js").AgentStatus[]): import("./messages.js").UsageData {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const s of statuses) {
		input += s.usage.input;
		output += s.usage.output;
		cost += s.usage.cost;
	}
	return {
		input: formatTokenCount(input),
		output: formatTokenCount(output),
		cost: `$${cost.toFixed(4)}`,
	};
}

function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
