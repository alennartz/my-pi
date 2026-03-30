/**
 * Subagents Extension — Entry point.
 *
 * Detects role via PI_PARENT_LINK env var:
 * - Absent: root agent. Starts broker, registers all tools.
 * - Present: has a parent. Connects to parent's broker, registers all tools.
 *
 * Both roles register the same six tools: subagent, fork, send, respond,
 * check_status, teardown. Any agent can spawn sub-groups (recursive).
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	type AgentConfig,
	type RegularAgentSpec,
	type ForkAgentSpec,
	discoverAgents,
	discoverPackageAgents,
	resolveSkillPaths,
	formatAgentList,
} from "./agents.js";

import type { TUI } from "@mariozechner/pi-tui";
import { SubagentManager } from "./group.js";
import { SubagentDashboard } from "./widget.js";
import {
	serializeAgentComplete,
	serializeAgentMessage,
	type BrokerRequest,
	type BrokerResponse,
	type AgentCompleteData,
} from "./messages.js";
import { createStopSequenceManager } from "./stop-sequences.js";

// ─── Delivery mode flag ──────────────────────────────────────────────────────
//
// When true, notifications are delivered with steering semantics: flushed
// immediately via sendMessage even while the agent is busy, letting pi
// inject them between tool-call rounds. An additional tool_execution_end
// trigger flushes accumulated notifications mid-turn. agent_end remains
// as a fallback for notifications that arrive while the LLM is streaming
// (no tool calls to trigger a flush).
//
// When false, the original behavior: notifications accumulate while the
// agent is busy and flush as a single batch on agent_end (follow-up
// semantics).

const USE_STEER_DELIVERY = true;

// ─── Child identity from env var ─────────────────────────────────────────────

interface ParentLink {
	id: string;
	channels: string[];
	task: string;
	brokerSocket: string;
	tools?: string[];
}

function getParentLink(): ParentLink | null {
	const raw = process.env.PI_PARENT_LINK;
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

	/** Remove a pending correlation waiter without resolving it. */
	cancelWaitForResponse(correlationId: string): void {
		this.correlationWaiters.delete(correlationId);
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
	const parentLink = getParentLink();
	const stopSequences = createStopSequenceManager(pi);

	// Tool gating: when a child agent has a tools restriction, only register
	// tools that appear in the allowed list. `respond` is always allowed
	// (infrastructure — any agent may need to answer blocking sends).
	const allowedTools = parentLink?.tools ? new Set(parentLink.tools) : null;
	function shouldRegisterTool(name: string): boolean {
		if (!allowedTools) return true; // no restriction
		if (name === "respond") return true; // always allowed
		return allowedTools.has(name);
	}

	// Shared state
	let manager: SubagentManager | null = null;
	let dashboard: SubagentDashboard | null = null;
	let tuiRef: TUI | null = null;
	let brokerClient: BrokerClient | null = null;
	const skillPathsMap = new Map<string, string[]>();

	// ─── Notification queue ─────────────────────────────────────────────
	//
	// Notifications accumulate in an internal queue and flush as a single
	// combined message at the right boundary:
	//
	// - Agent idle: flush immediately (prompt() path).
	// - Agent busy, USE_STEER_DELIVERY off: accumulate, flush on agent_end.
	//   (DR-019 — avoids cascading steer interrupts.)
	// - Agent busy, USE_STEER_DELIVERY on, tools running: accumulate,
	//   flush when the last in-flight tool call ends. Tool calls are
	//   paired by toolCallId (start/end) so we know the exact boundary.
	// - Agent busy, USE_STEER_DELIVERY on, LLM streaming (no tools):
	//   flush immediately — no batching opportunity.
	//
	// On flush we set parentBusy = true synchronously, before the
	// sendMessage call returns. This closes a race that would otherwise
	// exist: sendMessage with triggerTurn starts the turn asynchronously,
	// so agent_start hasn't fired yet when the next notification arrives.
	// Without the synchronous state transition, that notification would
	// see idle state and trigger a second flush — producing consecutive
	// messages (out-of-distribution for most LLMs).

	interface QueuedNotification {
		xml: string;
		source: "local" | "uplink";
	}

	const notificationQueue: QueuedNotification[] = [];
	let parentBusy = false;

	// Track in-flight tool calls by id so we can flush notifications
	// when the last tool in a round completes, rather than per-tool.
	const pendingToolCalls = new Set<string>();

	function queueNotification(xml: string, source: "local" | "uplink"): void {
		notificationQueue.push({ xml, source });
		if (!parentBusy) {
			// Agent is idle — flush immediately (goes through prompt() path).
			flushNotifications();
		} else if (USE_STEER_DELIVERY && pendingToolCalls.size === 0) {
			// Agent is busy but LLM is streaming (no tools running) —
			// no batching opportunity, flush immediately as steer.
			flushNotifications();
		}
		// Otherwise: tools are running — accumulate and flush when last tool ends.
		// Or: !USE_STEER_DELIVERY — accumulate and flush on agent_end (DR-019).
	}

	function flushNotifications(): void {
		if (notificationQueue.length === 0) return;
		if (parentBusy && !USE_STEER_DELIVERY) return;

		// Mark busy before sendMessage so any notification arriving between
		// now and the async agent_start event sees the correct state.
		parentBusy = true;

		const combined = notificationQueue.splice(0).map((n) => n.xml).join("\n");
		pi.sendMessage(
			{ customType: "subagents", content: combined, display: true },
			{ triggerTurn: true },
		);
	}

	/** Remove local (sub-group) entries, preserve uplink entries. */
	function drainLocalNotifications(): void {
		for (let i = notificationQueue.length - 1; i >= 0; i--) {
			if (notificationQueue[i].source === "local") {
				notificationQueue.splice(i, 1);
			}
		}
	}

	function clearNotificationQueue(): void {
		notificationQueue.length = 0;
	}

	pi.on("agent_start", async () => {
		parentBusy = true;
	});

	pi.on("agent_end", async () => {
		pendingToolCalls.clear();
		parentBusy = false;
		flushNotifications();
	});

	if (USE_STEER_DELIVERY) {
		pi.on("tool_execution_start", async (event) => {
			pendingToolCalls.add(event.toolCallId);
		});

		pi.on("tool_execution_end", async (event) => {
			pendingToolCalls.delete(event.toolCallId);
			if (pendingToolCalls.size === 0) {
				flushNotifications();
			}
		});
	}

	// ─── Package agent cache ─────────────────────────────────────────────
	//
	// Populated at session_start (which also re-fires on /reload).
	// Passed to discoverAgents() so package-sourced agents participate in
	// the four-tier merge.

	let cachedPackageAgents: { user: AgentConfig[], project: AgentConfig[] } | null = null;

	pi.on("session_start", async (_event, ctx) => {
		try {
			cachedPackageAgents = await discoverPackageAgents(ctx.cwd);
		} catch {
			cachedPackageAgents = null;
		}
	});

	// ─── Inject available agent definitions into system prompt ───────────

	pi.on("before_agent_start", async (event, ctx) => {
		// Only inject when the subagent tool is active for this agent
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes("subagent")) return;

		const agents = discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined).agents;
		if (agents.length === 0) return;

		const lines = [
			"",
			"## Available Agent Definitions",
			"",
			"The following agent definitions can be referenced in the subagent tool's `agent` field.",
			"Each is self-contained — it carries its own system prompt, model, and tool restrictions. The description below is all you need to choose and deploy them; do not read their definition files before using them. Just pass the name in the `agent` field with a task string.",
			"",
		];
		for (const a of agents) {
			lines.push(`- **${a.name}** (${a.source}): ${a.description}`);
		}
		lines.push("");
		lines.push("Omitting the `agent` field spawns a **default general-purpose agent** — use this unless the task specifically matches a specialist's description above. Specialized agents are for use cases matching their descriptions; when in doubt, use default.");

		return { systemPrompt: event.systemPrompt + "\n" + lines.join("\n") + "\n" };
	});

	// ─── Correlation origin tracking ────────────────────────────────────
	//
	// When a blocking message arrives (responseExpected=true), we record
	// which broker it came from so the respond tool can route the reply
	// to the correct broker. "uplink" = parent's broker, "local" = our
	// own broker (from a sub-agent).

	const correlationOrigin = new Map<string, "uplink" | "local">();

	// ─── Uplink setup (agents that have a parent) ──────────────────────

	if (parentLink) {
		brokerClient = new BrokerClient();

		// Connect to parent's broker on session start
		pi.on("session_start", async (_event, _ctx) => {
			try {
				await brokerClient!.connect(parentLink.brokerSocket, parentLink.id);

				// Handle incoming messages from parent's broker
				brokerClient!.onMessage((msg) => {
					if (msg.type === "message") {
						if (msg.responseExpected && msg.correlationId) {
							correlationOrigin.set(msg.correlationId, "uplink");
						}
						const xml = serializeAgentMessage({
							from: msg.from,
							content: msg.message,
							correlationId: msg.correlationId,
							responseExpected: msg.responseExpected ?? false,
						});
						queueNotification(xml, "uplink");
					}
				});
			} catch (err) {
				// Broker connection failed — agent can still function but can't communicate
				console.error(`[subagent:${parentLink.id}] Failed to connect to broker: ${err}`);
			}
		});
	}

	// ─── Lazy manager + widget initialization ───────────────────────────

	type ToolCtx = Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4];

	function ensureManager(ctx: ToolCtx): SubagentManager {
		if (manager) return manager;

		manager = new SubagentManager({
			pi,
			cwd: ctx.cwd,
			skillPaths: skillPathsMap,
			resolveContextWindow: (modelId: string) => {
				const all = ctx.modelRegistry.getAll();
				const found = all.find((m: any) => m.id === modelId);
				return found?.contextWindow;
			},
			onUpdate: () => {
				if (dashboard && tuiRef && manager) {
					dashboard.update(manager.getAgentStatuses());
					tuiRef.requestRender();
				}
			},
			onAgentComplete: (agentId, allDone) => {
				if (!manager) return;
				const status = manager.getAgentStatus(agentId);
				if (!status) return;
				const data: AgentCompleteData = {
					id: agentId,
					status: status.state === "failed" ? "failed" : "idle",
					output: status.lastOutput,
					error: status.state === "failed" ? "Process crashed" : undefined,
				};
				let xml = serializeAgentComplete(data);
				if (allDone) {
					const total = manager.getAgentStatuses().length;
					xml += `\n\nAll ${total} agent${total === 1 ? "" : "s"} have completed. Review results above, then call teardown to clean up — or use send first if you have follow-ups for any agent.`;
				}
				queueNotification(xml, "local");
			},
			onParentMessage: (xml, meta) => {
				if (meta.responseExpected && meta.correlationId) {
					correlationOrigin.set(meta.correlationId, "local");
				}
				queueNotification(xml, "local");
			},
		});

		return manager;
	}

	function ensureWidget(ctx: ToolCtx): void {
		if (dashboard || parentLink) return;
		ctx.ui.setWidget("subagents", (tui, theme) => {
			tuiRef = tui;
			dashboard = new SubagentDashboard(theme);
			return dashboard;
		});
	}

	/** Connect the parent broker client to the manager's broker (first call only). */
	async function ensureParentBrokerClient(): Promise<void> {
		if (!manager) return;
		const broker = manager.getBroker();
		if (!broker || parentBrokerClient) return;
		parentBrokerClient = new BrokerClient();
		await parentBrokerClient.connect(broker.socketPath, "parent");
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

	if (shouldRegisterTool("subagent")) pi.registerTool({
		name: "subagent",
		label: "Subagent Group",
		description: "Spawn a group of specialized subagents with channel-based inter-agent communication.",
		promptGuidelines: [
			"Spawns agents that run in parallel with isolated contexts. Non-blocking — returns immediately with an acknowledgment. Live status shown in the widget.",
			"Each agent gets its own pi process. Agents communicate via the send/respond tools using channels declared at spawn time.",
			"Parent (you) is auto-injected into every agent's channel list. The channels field governs agent-to-agent peer communication only.",
			"Agents can be added incrementally — call subagent again to add more agents to the existing set. New agents join the running infrastructure.",
			"Spawning is non-blocking — results arrive later as system notifications. Unless explicitly told to do other work after spawning, briefly describe what you launched and end your turn immediately with no further actions.",
			"When system notifications arrive, respond with your analysis and next actions. The notification content is already visible to the user — summarize your takeaway, not the raw content.",
			"Use subagent when the work needs multiple coordinated agents, specialized personas, or a clean slate. Use fork when you want a copy of yourself with your full context to explore something.",
			"For task decomposition, pattern selection, and when-to-delegate guidance, read the orchestrating-agents skill.",
		],
		parameters: Type.Object({
			agents: Type.Array(AgentItem, { description: "Agents to spawn in this group" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const discovery = discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined);
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

			// Validate unique ids (including against existing agents)
			const mgr = ensureManager(ctx);
			const existingIds = new Set(mgr.getAgentStatuses().map((s) => s.id));
			const ids = params.agents.map((a) => a.id);
			const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
			if (dupes.length > 0) {
				throw new Error(`Duplicate agent ids: ${dupes.join(", ")}`);
			}
			for (const id of ids) {
				if (existingIds.has(id)) {
					throw new Error(`Agent id "${id}" already exists`);
				}
			}

			// Resolve skill paths for agents that declare skills
			const commands = pi.getCommands();
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

			// Map params to RegularAgentSpec[]
			const agentSpecs: RegularAgentSpec[] = params.agents.map(a => ({
				kind: "agent" as const,
				...a,
			}));

			ensureWidget(ctx);
			const ack = await mgr.start(agentSpecs, allAgentConfigs);
			await ensureParentBrokerClient();

			// Push initial statuses so the widget renders immediately
			if (dashboard && tuiRef) {
				dashboard.update(mgr.getAgentStatuses());
				tuiRef.requestRender();
			}

			stopSequences.addOnce("<agent_complete");
			return {
				content: [{ type: "text", text: ack }],
			};
		},
	});

	// ─── Tool: fork ──────────────────────────────────────────────────────

	const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

	if (shouldRegisterTool("fork")) pi.registerTool({
		name: "fork",
		label: "Fork",
		description: "Clone yourself into a sub-agent with your full conversation history.",
		promptGuidelines: [
			"Clones yourself into a sub-agent with your full conversation history. The clone explores independently while you continue working — use for divergent exploration without committing context.",
			"Two parameters: id and task. Use fork when you want a copy of yourself with full context to explore an alternative path. Use subagent for multiple agents, specialized personas, or a clean slate.",
			"Fork adds a single agent — send, respond, check_status, and teardown all work normally. Notifications arrive the same way as subagent spawns.",
			"Forking is non-blocking — results arrive later as a system notification. Unless explicitly told to do other work after forking, briefly describe what you launched and end your turn immediately with no further actions.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Unique identifier for the forked agent" }),
			task: Type.String({ description: "Task description for the forked clone" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mgr = ensureManager(ctx);

			// Validate id doesn't conflict with existing agents
			if (mgr.getAgentStatus(params.id)) {
				throw new Error(`Agent id "${params.id}" already exists`);
			}

			// Gather parent state
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Cannot fork: no active session file");
			}

			// Tools: intersect active tools with built-in set
			const activeTools = pi.getActiveTools();
			const filteredTools = BUILTIN_TOOLS.filter((t) => activeTools.includes(t));
			// If all built-ins are active, pass empty array (omit --tools flag)
			const tools = filteredTools.length === BUILTIN_TOOLS.length ? [] : filteredTools;

			// Skills: gather paths from active skill commands
			const commands = pi.getCommands();
			const skillPaths = commands
				.filter((cmd: any) => cmd.source === "skill" && cmd.path)
				.map((cmd: any) => cmd.path!);

			// Thinking level
			const thinkingLevel = pi.getThinkingLevel() as string;

			// Build spec
			const forkSpec: ForkAgentSpec = {
				kind: "fork",
				id: params.id,
				task: params.task,
				sessionFile,
				tools,
				skillPaths,
				thinkingLevel,
			};

			ensureWidget(ctx);
			const ack = await mgr.start([forkSpec], []);
			await ensureParentBrokerClient();

			// Push initial statuses
			if (dashboard && tuiRef) {
				dashboard.update(mgr.getAgentStatuses());
				tuiRef.requestRender();
			}

			stopSequences.addOnce("<agent_complete");
			return {
				content: [{ type: "text", text: ack }],
			};
		},
	});

	// ─── Tool: send ──────────────────────────────────────────────────────

	if (shouldRegisterTool("send")) pi.registerTool({
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

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (signal?.aborted) throw new Error("Cancelled");

			// Route to the correct broker:
			// - Target is in our own sub-group → parentBrokerClient (our local broker)
			// - Otherwise → brokerClient (uplink to parent's broker)
			let client: BrokerClient | null;
			let from: string;

			const isLocalAgent = manager?.getAgentStatus(params.to) !== undefined;

			if (isLocalAgent) {
				if (!parentBrokerClient) throw new Error("Broker client not connected");
				client = parentBrokerClient;
				from = "parent";
			} else if (parentLink) {
				if (!brokerClient) throw new Error("Not connected to parent broker");
				client = brokerClient;
				from = parentLink.id;
			} else {
				throw new Error("No agents running. Spawn agents first with the subagent or fork tool.");
			}

			const correlationId = params.expectResponse ? crypto.randomUUID() : undefined;

			const resp = await client.sendAndWait({
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
				// Race the blocking wait against the abort signal so Escape
				// (or any other cancellation) can unblock the tool call.
				const responseMsg = await new Promise<BrokerResponse>((resolve, reject) => {
					if (signal?.aborted) {
						client!.cancelWaitForResponse(correlationId!);
						reject(new Error("Cancelled"));
						return;
					}

					const onAbort = () => {
						client!.cancelWaitForResponse(correlationId!);
						reject(new Error("Cancelled"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					client!.waitForResponse(correlationId!).then((msg) => {
						signal?.removeEventListener("abort", onAbort);
						resolve(msg);
					});
				});

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

	if (shouldRegisterTool("respond")) pi.registerTool({
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
			// Route response to the broker that originated the correlation
			const origin = correlationOrigin.get(params.correlationId);
			correlationOrigin.delete(params.correlationId);

			let client: BrokerClient | null;
			let from: string;

			if (origin === "local") {
				client = parentBrokerClient;
				from = "parent";
			} else if (origin === "uplink") {
				client = brokerClient;
				from = parentLink?.id ?? "parent";
			} else {
				// Fallback: no origin tracked — use current behavior
				client = parentLink ? brokerClient : parentBrokerClient;
				from = parentLink?.id ?? "parent";
			}

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

	if (shouldRegisterTool("check_status")) pi.registerTool({
		name: "check_status",
		label: "Check Status",
		description: "Query agent status. Omit agent for summary of all agents.",
		promptGuidelines: [
			"Prefer waiting for automatic notifications (<agent_complete>) over calling this tool. Notifications arrive without polling.",
			"Use only when you have a specific reason: diagnosing a suspected stall, answering a user question about progress, or checking usage mid-run.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent id to query. Omit for group summary." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!manager || !manager.hasAgents()) {
				throw new Error("No agents running.");
			}

			if (params.agent) {
				const status = manager.getAgentStatus(params.agent);
				if (!status) {
					throw new Error(`Unknown agent: "${params.agent}"`);
				}
				return {
					content: [{ type: "text", text: formatAgentStatusDetail(status) }],
				};
			}

			const statuses = manager.getAgentStatuses();
			const lines = statuses.map(formatAgentStatusSummary);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		},
	});

	// ─── Tool: teardown ──────────────────────────────────────────────────

	if (shouldRegisterTool("teardown")) pi.registerTool({
		name: "teardown",
		label: "Teardown",
		description: "Remove an agent or tear down all agents. Returns a completion report.",
		promptGuidelines: [
			"Call when an agent or all agents are no longer needed. Idle agents remain fully functional — you can send new messages to restart work or use agents as persistent specialists.",
			"With an agent id: removes that single agent and returns its completion report. Without: tears down all agents and returns a <group_complete> summary with aggregate usage.",
			"When the last agent is removed (either explicitly or via full teardown), infrastructure is cleaned up automatically.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent id to remove. Omit to tear down all agents." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!manager || !manager.hasAgents()) {
				throw new Error("No agents to teardown.");
			}

			const { report, empty } = await manager.teardown(params.agent);

			if (empty) {
				// Infrastructure torn down — clean up widget and parent broker client
				if (parentBrokerClient) {
					parentBrokerClient.disconnect();
					parentBrokerClient = null;
				}
				manager = null;
				drainLocalNotifications();
				ctx.ui.setWidget("subagents", undefined as any);
				dashboard = null;
				tuiRef = null;
				skillPathsMap.clear();
			}

			const label = params.agent ? `Agent "${params.agent}" removed.` : "All agents terminated.";
			return {
				content: [{ type: "text", text: `${label}\n\n${report}` }],
			};
		},
	});

	// ─── Parent broker client (lazy init) ────────────────────────────────

	let parentBrokerClient: BrokerClient | null = null;

	// ─── Cleanup on shutdown ─────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		clearNotificationQueue();
		if (manager) {
			await manager.teardown();
			manager = null;
		}
		if (parentBrokerClient) {
			parentBrokerClient.disconnect();
			parentBrokerClient = null;
		}
		if (brokerClient) {
			brokerClient.disconnect();
			brokerClient = null;
		}
		dashboard = null;
		tuiRef = null;
		skillPathsMap.clear();
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
	const totalInput = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite;
	lines.push(`Usage: ↑${totalInput} ↓${s.usage.output} $${s.usage.cost.toFixed(4)} (${s.usage.turns} turns)`);
	if (s.pendingCorrelations.length > 0) {
		lines.push(`Pending correlations: ${s.pendingCorrelations.join(", ")}`);
	}
	return lines.join("\n");
}
