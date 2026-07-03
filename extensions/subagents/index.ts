/**
 * Subagents Extension — Entry point.
 *
 * Detects role via PI_PARENT_LINK env var:
 * - Absent: root agent. Starts broker, registers all tools.
 * - Present: has a parent. Connects to parent's broker, registers all tools.
 *
 * Both roles register the same eight tools: subagent, fork, send, respond,
 * check_status, teardown, await_agents, interrupt. Any agent can spawn child agents recursively.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentConfig,
	type RegularAgentSpec,
	type ForkAgentSpec,
	discoverAgents,
	discoverPackageAgents,
	resolveSkillPaths,
	resolveAgentCwds,
	formatAgentList,
} from "./agents.js";

import type { TUI } from "@earendil-works/pi-tui";
import { detect } from "@pimote/panels";
import type { PanelHandle, Card, CardColor } from "@pimote/panels";
import { SubagentManager } from "./agent-set.js";
import { getPersistencePaths } from "./persistence.js";
import { SubagentDashboard } from "./widget.js";
import type { AgentStatus, AgentState } from "./agent-set.js";
import {
	serializeAgentComplete,
	serializeAgentMessage,
	type BrokerRequest,
	type BrokerResponse,
	type AgentCompleteData,
} from "./messages.js";
import { createStopSequenceManager } from "./stop-sequences.js";
import { NotificationQueue } from "./notification-queue.js";
import { formatTokenCount } from "./format.js";
import { formatSpawnToolResult } from "./tool-result.js";
import {
	SESSION_DEFAULT_LABEL,
	TIER_NAMES,
	type TierConfig,
	isTierName,
	loadTierConfig,
	resolveModelRef,
	renderTierTable,
	stripThinkingSuffix,
} from "./model-tiers.js";

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
			let connected = false;
			this.socket = net.createConnection(socketPath, () => {
				this.write({ type: "register", agentId });
				// Wait for registered response
				this.waitForNext().then((msg) => {
					if (msg.type === "registered") {
						connected = true;
						resolve();
					} else {
						reject(new Error(`Expected 'registered', got '${msg.type}'`));
					}
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

					// Correlation-based dispatch for response/error with correlationId.
					// Frames whose correlation has no waiter (e.g. the blocking send was
					// aborted) are dropped — feeding them to the FIFO waiter queue would
					// let a stale response resolve a later sendAndWait's ack.
					if ((parsed.type === "response" || parsed.type === "error") && parsed.correlationId) {
						const waiter = this.correlationWaiters.get(parsed.correlationId);
						if (waiter) {
							this.correlationWaiters.delete(parsed.correlationId);
							waiter(parsed);
						}
						continue;
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
				// Before connect settles, the only channel for failure is the connect
				// promise. After a successful connect a socket error would otherwise be
				// silent — the dropped broker link only shows up as hung sends — so
				// surface it.
				if (connected) {
					console.error(`[subagent broker client:${agentId}] socket error after connect: ${err}`);
				} else {
					reject(err);
				}
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

	// ─── Model tiers ──────────────────────────────────────────────────────────────
	//
	// Config is read fresh on every call — the files are tiny, and edits
	// apply without /reload. Project config lives under the literal ".pi"
	// dir (cf. findNearestProjectAgentsDir in agents.ts), which is stable
	// regardless of the PI_CODING_AGENT_DIR override on the global agent dir.

	function loadTiers(cwd: string, projectTrusted: boolean): TierConfig {
		return loadTierConfig({
			globalPath: path.join(getAgentDir(), "model-tiers.json"),
			projectPath: path.join(cwd, ".pi", "model-tiers.json"),
			projectTrusted,
		});
	}

	// Per-extension-load dedup for tier warnings/notices (cf. model-prompt-overlays
	// diagnostics): each distinct message is surfaced at most once for the
	// lifetime of this extension instance — the set is closure-scoped, so it
	// spans sessions within the same pi process, not just a single session.
	const notifiedTierIssues = new Set<string>();

	function notifyTierIssueOnce(
		ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
		message: string,
	): void {
		if (notifiedTierIssues.has(message)) return;
		notifiedTierIssues.add(message);
		ctx.ui.notify(message, "warning");
	}

	// Shared state
	let manager: SubagentManager | null = null;
	let dashboard: SubagentDashboard | null = null;
	let panelHandle: PanelHandle | null = null;
	let tuiRef: TUI | null = null;
	let brokerClient: BrokerClient | null = null;
	let parentBrokerClient: BrokerClient | null = null;
	const skillPathsMap = new Map<string, string[]>();

	/**
	 * Push the given statuses to whichever display surface is active (TUI
	 * widget or panel). Single home for the update/render/updateCards block
	 * that every spawn/teardown path and the manager's onUpdate share.
	 */
	function refreshDisplays(statuses: AgentStatus[]): void {
		if (dashboard && tuiRef) {
			dashboard.update(statuses);
			tuiRef.requestRender();
		}
		if (panelHandle) {
			panelHandle.updateCards(statusesToCards(statuses));
		}
	}

	/**
	 * Reject the batch if any id collides within itself or with a live agent.
	 * Shared by the subagent and resurrect tools.
	 */
	function assertNewAgentIds(ids: string[], mgr: SubagentManager): void {
		const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
		if (dupes.length > 0) {
			throw new Error(`Duplicate agent ids: ${[...new Set(dupes)].join(", ")}`);
		}
		const existingIds = new Set(mgr.getAgentStatuses().map((s) => s.id));
		for (const id of ids) {
			if (existingIds.has(id)) {
				throw new Error(`Agent id "${id}" already exists`);
			}
		}
	}

	// ─── Notification queue ─────────────────────────────────────────────

	const queue = new NotificationQueue({
		steerDelivery: USE_STEER_DELIVERY,
		deliver(combined: string) {
			pi.sendMessage(
				{ customType: "subagents", content: combined, display: true },
				{ triggerTurn: true },
			);
		},
	});

	// await_agents state — a single object holds the whole in-flight wait so
	// its parts can't drift out of sync. Null when no wait is active.
	interface WaitState {
		resolve: (result: string) => void;
		satisfied: () => boolean;
		abortCleanup: (() => void) | null;
	}
	let waitState: WaitState | null = null;

	function resolveWait(): void {
		if (!waitState) return;
		const state = waitState;
		waitState = null;
		state.abortCleanup?.();
		queue.setWaiting(false);
		state.resolve(queue.drainAll());
	}

	/** Shared await logic — blocks until the given agent IDs are all idle/failed. */
	async function awaitAgentCompletion(ids: string[], mgr: SubagentManager, signal?: AbortSignal | null): Promise<string> {
		const isSatisfied = () => {
			return ids.every((id) => {
				const s = mgr.getAgentStatus(id);
				return !s || s.state === "idle" || s.state === "failed";
			});
		};

		// Early satisfaction — all scoped agents already done
		if (isSatisfied()) {
			const result = queue.drainAll();
			return result || "All specified agents have already completed. No pending notifications.";
		}

		// Guard against concurrent await_agents calls
		if (waitState) {
			throw new Error("Another await_agents call is already active.");
		}

		// Enter wait mode
		queue.setWaiting(true);

		try {
			const result = await new Promise<string>((resolve, reject) => {
				const state: WaitState = { resolve, satisfied: isSatisfied, abortCleanup: null };
				waitState = state;

				if (signal) {
					const onAbort = () => {
						waitState = null;
						queue.setWaiting(false);
						reject(new Error("Aborted"));
					};
					if (signal.aborted) {
						onAbort();
						return;
					}
					signal.addEventListener("abort", onAbort, { once: true });
					state.abortCleanup = () => signal.removeEventListener("abort", onAbort);
				}
			});

			return result || "All specified agents have completed. No pending notifications.";
		} catch (err: any) {
			if (err?.message === "Aborted") {
				throw new Error("Wait cancelled.");
			}
			throw err;
		}
	}

	pi.on("agent_start", async () => {
		queue.setParentBusy(true);
	});

	pi.on("agent_end", async () => {
		queue.clearPendingTools();
		queue.setParentBusy(false);
	});

	// Keep the dashboard title in sync when the session is renamed.
	pi.on("session_info_changed", async (event) => {
		if (!dashboard || !tuiRef) return;
		dashboard.setSessionName(event.name);
		tuiRef.requestRender();
	});

	if (USE_STEER_DELIVERY) {
		pi.on("tool_execution_start", async (event) => {
			queue.trackToolStart(event.toolCallId);
		});

		pi.on("tool_execution_end", async (event) => {
			queue.trackToolEnd(event.toolCallId);
		});
	}

	// ─── Package agent cache ─────────────────────────────────────────────
	//
	// Populated at session_start (which also re-fires on /reload).
	// Passed to discoverAgents() so package-sourced agents participate in
	// the four-tier merge.

	let cachedPackageAgents: { user: AgentConfig[], project: AgentConfig[] } | null = null;

	pi.on("session_start", async (event, ctx) => {
		try {
			cachedPackageAgents = await discoverPackageAgents(ctx.cwd);
		} catch {
			cachedPackageAgents = null;
		}

		if (parentLink) return;

		// Persistence restore only makes sense for genuine resumes of a previous
		// pi process. On startup we may legitimately have crash-dropped state to
		// recover, but on "new" and "fork" the user is starting a fresh logical
		// session and shouldn't inherit whatever agents the prior session had.
		if (event.reason === "new" || event.reason === "fork") return;

		const mgr = ensureManager(ctx);
		const discovery = discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined);
		await mgr.restoreFromPersistence(discovery.agents);
		if (!mgr.hasAgents()) return;

		await ensureWidget(ctx);
		await ensureParentBrokerClient();
		refreshDisplays(mgr.getAgentStatuses());
		stopSequences.addOnce("<agent_idle");
	});

	// ─── Inject available agent definitions into system prompt ───────────

	pi.on("before_agent_start", async (event, ctx) => {
		// Only inject when the subagent tool is active for this agent
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes("subagent")) return;

		const agents = discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined).agents;

		const lines = [""];

		if (agents.length > 0) {
			lines.push(
				"## Available Agent Definitions",
				"",
				"The following agent definitions can be referenced in the subagent tool's `agent` field.",
				"Each is self-contained — it carries its own system prompt, model, and tool restrictions. The description below is all you need to choose and deploy them; do not read their definition files before using them. Just pass the name in the `agent` field with a task string.",
				"",
			);
			for (const a of agents) {
				lines.push(`- **${a.name}** (${a.source}): ${a.description}`);
			}
			lines.push("");
		}

		const availableModels: any[] = ctx.modelRegistry.getAvailable();
		const isAvailable = (ref: string) =>
			availableModels.some(
				(m: any) => m?.id === ref || `${m?.provider}/${m?.id}` === ref,
			);
		const tiers = loadTiers(ctx.cwd, ctx.isProjectTrusted());
		const defaultModelRef = ctx.model?.id ?? SESSION_DEFAULT_LABEL;

		lines.push(
			"## Model Tiers",
			"",
			"The `subagent` tool's `agents[].model` field accepts a tier name. Tiers resolve to concrete models at spawn time:",
			"",
			...renderTierTable(tiers, isAvailable, defaultModelRef),
			"",
			"Pick the tier matching the task's difficulty. Raw model IDs are also accepted in `agents[].model` when the user names a specific model; `list_models` shows the full catalog.",
			"",
		);

		lines.push("Omitting the `agent` field spawns a **default general-purpose agent** — use this unless the task specifically matches a specialist's description above. You may set `model` to override model selection unless the chosen specialist definition already pins a model.");
		lines.push("");
		lines.push("Tiers are the preferred vocabulary for `model`. Omit `model` entirely when the session default is fine.");

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
						queue.queue(xml, "uplink");
						if (queue.isWaiting) {
							resolveWait();
						}
					}
				});
			} catch (err) {
				// Broker connection failed — agent can still function but can't communicate
				console.error(`[subagent:${parentLink.id}] Failed to connect to broker: ${err}`);
			}
		});
	}

	// ─── Lazy manager + widget initialization ───────────────────────────

	function ensureManager(ctx: ExtensionContext): SubagentManager {
		if (manager) return manager;

		manager = new SubagentManager({
			pi,
			cwd: ctx.cwd,
			parentSessionFile: ctx.sessionManager.getSessionFile(),
			skillPaths: skillPathsMap,
			resolveContextWindow: (modelId: string) => {
				const all = ctx.modelRegistry.getAvailable();
				const found = all.find((m: any) => m.id === modelId);
				return found?.contextWindow;
			},
			onUpdate: (mgr) => {
				refreshDisplays(mgr.getAgentStatuses());
			},
			onAgentComplete: (mgr, agentId, allDone) => {
				const status = mgr.getAgentStatus(agentId);
				if (!status) return;
				const data: AgentCompleteData = {
					id: agentId,
					status: status.state === "failed" ? "failed" : "idle",
					output: status.lastOutput,
					error: status.state === "failed" ? (status.lastError || "Process crashed") : undefined,
				};
				let xml = serializeAgentComplete(data);
				if (allDone) {
					const total = mgr.getAgentStatuses().length;
					xml += `\n\nAll ${total} agent${total === 1 ? "" : "s"} are now idle. Use send to ask questions or continue their work. When you're done with them, call teardown to clean up.`;
				}
				queue.queue(xml, "local");
				if (queue.isWaiting && waitState?.satisfied()) {
					resolveWait();
				}
			},
			onParentMessage: (xml, meta) => {
				if (meta.responseExpected && meta.correlationId) {
					correlationOrigin.set(meta.correlationId, "local");
				}
				queue.queue(xml, "local");
				if (queue.isWaiting) {
					resolveWait();
				}
			},
		});

		return manager;
	}

	async function ensureWidget(ctx: ExtensionContext): Promise<void> {
		if (dashboard || panelHandle || parentLink) return;

		if (ctx.mode === "tui") {
			const initialName = ctx.sessionManager?.getSessionName?.();
			ctx.ui.setWidget("subagents", (tui, theme) => {
				tuiRef = tui;
				dashboard = new SubagentDashboard(theme);
				dashboard.setSessionName(initialName);
				return dashboard;
			});
		} else {
			panelHandle = detect(pi, "subagents");
		}
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
		id: Type.String({ description: "Unique identifier for this agent among the parent's active agents" }),
		agent: Type.Optional(Type.String({ description: "Agent definition name (omit for default agent)" })),
		model: Type.Optional(Type.String({ description: "Optional model override: a tier name (`cheap`, `medium`, `smart`, `frontier`) or a concrete model id. Ignored if the selected specialist agent definition already pins a model." })),
		task: Type.String({ description: "Task description for this agent" }),
		channels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Peer agent ids this agent can send to (agent-to-agent only; parent is always allowed)",
			}),
		),
		cwd: Type.Optional(Type.String({
			description:
				"Working directory for this agent. Relative paths resolve against the parent's cwd. " +
				"Defaults to the parent's cwd. The subagent boots as if pi were freshly launched in this directory \u2014 " +
				"its AGENTS.md, project agents, and project skills are discovered relative to it.",
		})),
	});

	const ResurrectItem = Type.Object({
		id: Type.String({ description: "Unique identifier for the resurrected agent among the parent's active agents" }),
		sessionId: Type.String({ description: "session_id surfaced by a prior teardown report" }),
		channels: Type.Array(Type.String(), { description: "Peer agent ids this agent can send to (re-declared fresh; siblings resurrected in the same batch are valid targets). Parent is always allowed." }),
		task: Type.String({ description: "Directive the agent runs on resurrection" }),
	});

	// ─── Tool: list_models ──────────────────────────────────────────────────────

	if (shouldRegisterTool("list_models")) pi.registerTool({
		name: "list_models",
		label: "List Models",
		description: "List all available models with context window and pricing. Complements the model-tier table for cases where a concrete model is explicitly required.",
		promptSnippet: "Call `list_models` to see the full model catalog when a concrete model id (rather than a tier) is explicitly required.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const models: any[] = ctx.modelRegistry.getAvailable();
			const fmtCost = (value: unknown) =>
				typeof value === "number" ? value.toFixed(2) : "-";
			const rows = models
				.map((m: any) => ({
					ref: `${m?.provider}/${m?.id}`,
					contextWindow: typeof m?.contextWindow === "number" ? String(m.contextWindow) : "-",
					input: fmtCost(m?.cost?.input),
					output: fmtCost(m?.cost?.output),
					cacheRead: fmtCost(m?.cost?.cacheRead),
				}))
				.sort((a, b) => a.ref.localeCompare(b.ref));
			const lines = [
				"| provider/id | context window | input $/Mtok | output $/Mtok | cacheRead $/Mtok |",
				"| --- | --- | --- | --- | --- |",
				...rows.map((r) => `| ${r.ref} | ${r.contextWindow} | ${r.input} | ${r.output} | ${r.cacheRead} |`),
			];
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	if (shouldRegisterTool("subagent")) pi.registerTool({
		name: "subagent",
		label: "Subagents",
		description: "Spawn specialized subagents with channel-based inter-agent communication.",
		promptGuidelines: [
			"Spawns agents that run in parallel with isolated contexts. Non-blocking — returns immediately with an acknowledgment. Live status shown in the widget.",
			"Each agent gets its own pi process. Agents communicate via the send/respond tools using channels declared at spawn time.",
			"Parent (you) is auto-injected into every agent's channel list. The channels field governs agent-to-agent peer communication only.",
			"Agents can be added incrementally — call subagent again to add more agents to the existing set. New agents join the running infrastructure.",
			"Spawning is non-blocking — results arrive later as system notifications. Unless explicitly told to do other work after spawning, briefly describe what you launched and end your turn immediately with no further actions.",
			"When system notifications arrive, respond with your analysis and next actions. The notification content is already visible to the user — summarize your takeaway, not the raw content.",
			"Use subagent when the work needs multiple coordinated agents, specialized personas, or a clean slate. Use fork when you want a copy of yourself with your full context to explore something.",
			"You may set `model` to override model selection, but if the selected specialist agent definition pins a model, that pinned model is used.",
			"For task decomposition, pattern selection, and when-to-delegate guidance, read the orchestrating-agents skill.",
		],
		parameters: Type.Object({
			agents: Type.Array(AgentItem, { description: "Agents to spawn under this parent session" }),
			await: Type.Optional(Type.Boolean({ description: "Block until all spawned agents complete. Default: false.", default: false })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const discovery = discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined);
			const allAgentConfigs = discovery.agents;

			// Available models — used for both validation and spawn-time resolution.
			// getAvailable() returns only models with configured auth, which is the
			// right set for disambiguation: if a bare id like "gpt-5.4" matches both
			// a built-in provider and azure-foundry, only the one with auth is valid.
			const availableModels: any[] = ctx.modelRegistry.getAvailable();
			const isValidModelRef = (model: string) =>
				availableModels.some(
					(m: any) => m?.id === model || `${m?.provider}/${m?.id}` === model,
				);

			// Validate agent definitions and model overrides
			for (const a of params.agents) {
				let foundConfig: AgentConfig | undefined;
				if (a.agent) {
					foundConfig = allAgentConfigs.find((c) => c.name === a.agent);
					if (!foundConfig) {
						const available = formatAgentList(allAgentConfigs, 10);
						throw new Error(
							`Unknown agent definition "${a.agent}". Available: ${available.text}`,
						);
					}
				}

				if (a.model) {
					// Specialist-pinned model always wins; only validate override when it can actually apply.
					// Tier names are always valid — they resolve (or fall back) at spawn time.
					// A suffixed model ref (e.g. "provider/id:xhigh") validates against its model part.
					const modelPartForValidation = stripThinkingSuffix(a.model).model;
					if (!foundConfig?.model && !isTierName(a.model) && !isValidModelRef(modelPartForValidation)) {
						const available = availableModels
							.map((m: any) => `${m?.provider}/${m?.id}`)
							.filter(Boolean)
							.sort();
						const preview = available.length > 0 ? available.slice(0, 20).join(", ") : "none";
						const more = available.length > 20 ? `, ... (+${available.length - 20} more)` : "";
						throw new Error(
							`Unknown model "${modelPartForValidation}" for agent "${a.id}". Tiers: ${TIER_NAMES.join(", ")}. Available models: ${preview}${more}`,
						);
					}
				}
			}

			// Validate unique ids (including against existing agents)
			const mgr = ensureManager(ctx);
			assertNewAgentIds(params.agents.map((a) => a.id), mgr);

			// Resolve and validate per-agent cwd overrides. Throws atomically on
			// any invalid cwd before any RpcChild is constructed.
			const resolvedCwds = resolveAgentCwds(
				params.agents.map((a) => ({ id: a.id, cwd: a.cwd })),
				ctx.cwd,
			);

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

			// Map params to RegularAgentSpec[], resolving bare model ids to provider/id
			// so the child process gets an unambiguous --model arg. resolveCliModel in
			// the child uses getAll() + find() (first match), which picks built-in
			// providers before extension providers. By resolving here against
			// getAvailable() (auth-filtered), we always pick the provider that's
			// actually configured, regardless of ordering in getAll().
			const tiers = loadTiers(ctx.cwd, ctx.isProjectTrusted());
			const agentSpecs: RegularAgentSpec[] = params.agents.map(a => {
				const agentConfig = a.agent ? allAgentConfigs.find((c) => c.name === a.agent) : undefined;
				// Agent-pinned model wins over tool override — resolve whichever applies.
				const rawModel = agentConfig?.model ?? a.model;
				let model: string | undefined = rawModel;
				if (model) {
					// Tier names resolve to configured model ids; unconfigured or
					// unavailable tiers fall back to the session default (no --model).
					if (isTierName(model) && Object.keys(tiers).length === 0) {
						notifyTierIssueOnce(ctx, "model tiers unconfigured; all tiers use the session default model");
					}
					const resolution = resolveModelRef(model, tiers, isValidModelRef);
					if (resolution.warning) notifyTierIssueOnce(ctx, resolution.warning);
					model = resolution.model;
				}
				if (model) {
					// Strip any thinking suffix before provider-disambiguation, then
					// re-append it so a bare "id:level" still gets provider-resolved
					// (DR-036) while the level is preserved.
					const { model: modelPart, thinking } = stripThinkingSuffix(model);
					const resolved = availableModels.find(
						(m: any) => m?.id === modelPart || `${m?.provider}/${m?.id}` === modelPart,
					);
					if (resolved?.provider && resolved?.id) {
						model = thinking
							? `${resolved.provider}/${resolved.id}:${thinking}`
							: `${resolved.provider}/${resolved.id}`;
					}
				}
				return { kind: "agent" as const, ...a, model, cwd: resolvedCwds.get(a.id) };
			});

			await ensureWidget(ctx);
			const ack = await mgr.start(agentSpecs, allAgentConfigs);
			await ensureParentBrokerClient();

			// Push initial statuses so the widget renders immediately
			refreshDisplays(mgr.getAgentStatuses());

			stopSequences.addOnce("<agent_idle");

			if (params.await) {
				const ids = params.agents.map((a) => a.id);
				const waitResult = await awaitAgentCompletion(ids, mgr, signal);
				return {
					content: [{ type: "text", text: formatSpawnToolResult(waitResult) }],
				};
			}

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
			await: Type.Optional(Type.Boolean({ description: "Block until the forked agent completes. Default: false.", default: false })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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

			await ensureWidget(ctx);
			const ack = await mgr.start([forkSpec], []);
			await ensureParentBrokerClient();

			// Push initial statuses
			refreshDisplays(mgr.getAgentStatuses());

			stopSequences.addOnce("<agent_idle");

			if (params.await) {
				const waitResult = await awaitAgentCompletion([params.id], mgr, signal);
				return {
					content: [{ type: "text", text: formatSpawnToolResult(waitResult) }],
				};
			}

			return {
				content: [{ type: "text", text: ack }],
			};
		},
	});

	// ─── Tool: send ──────────────────────────────────────────────────────

	if (shouldRegisterTool("send")) pi.registerTool({
		name: "send",
		label: "Send Message",
		description: "Send a message to another active agent.",

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
			// - Target is one of our own child agents → parentBrokerClient (our local broker)
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

			// Register the correlation waiter BEFORE writing the send. The broker
			// forwards the message to the target before acking the sender, so a
			// fast response can arrive in the same chunk as the send_ack — if the
			// waiter isn't registered yet, that response is dropped and this tool
			// call hangs forever.
			const responsePromise = correlationId ? client.waitForResponse(correlationId) : null;

			const resp = await client.sendAndWait({
				type: "send",
				from,
				to: params.to,
				message: params.message,
				correlationId,
				expectResponse: params.expectResponse,
			});

			if (resp.type === "error") {
				if (correlationId) client.cancelWaitForResponse(correlationId);
				throw new Error(resp.error);
			}

			if (responsePromise && correlationId) {
				// Where async-delivered replies should be queued: uplink if the send
				// went through the parent's broker, local if to one of our children.
				const queueTag: "uplink" | "local" = client === brokerClient ? "uplink" : "local";

				// When a detached send's reply finally lands, deliver it as an
				// unsolicited agent_message notification rather than a tool result.
				// The original correlation_id rides along as the only thread tying
				// the late reply back to the question that was asked.
				const deliverDeferredResponse = (msg: BrokerResponse) => {
					let content: string;
					if (msg.type === "response") {
						content = msg.message;
					} else if (msg.type === "error") {
						content = `(no response — ${msg.error})`;
					} else {
						return;
					}
					const xml = serializeAgentMessage({
						from: params.to,
						content,
						correlationId,
						responseExpected: false,
					});
					queue.queue(xml, queueTag);
					if (queue.isWaiting) resolveWait();
				};

				// Race the blocking wait against the abort signal. On abort we do NOT
				// cancel the send — we detach it: this tool call returns so the user
				// can inject context, the target keeps working, and its eventual
				// reply is delivered asynchronously via deliverDeferredResponse.
				type RaceResult = { kind: "response"; msg: BrokerResponse } | { kind: "deferred" };
				const outcome = await new Promise<RaceResult>((resolve) => {
					let settled = false;

					const detach = () => {
						if (settled) return;
						settled = true;
						// Keep the local correlation waiter registered so responsePromise
						// still resolves below. Tell the broker to drop the deadlock edge
						// (the parent is no longer blocked) while keeping the pending
						// correlation so the target's respond still routes back here.
						client!.write({ type: "detach", correlationId });
						resolve({ kind: "deferred" });
					};

					const onAbort = () => detach();

					if (signal?.aborted) {
						detach();
					} else {
						signal?.addEventListener("abort", onAbort, { once: true });
					}

					responsePromise.then((msg) => {
						signal?.removeEventListener("abort", onAbort);
						if (settled) {
							// Abort already converted this to a deferred wait — deliver the
							// late reply as an async notification instead of a tool result.
							deliverDeferredResponse(msg);
							return;
						}
						settled = true;
						resolve({ kind: "response", msg });
					});
				});

				if (outcome.kind === "deferred") {
					return {
						content: [{
							type: "text",
							text:
								`Your blocking wait on "${params.to}" was interrupted, not cancelled. ` +
								`"${params.to}" is still working; its reply will arrive later as an ` +
								`<agent_message> notification (correlation_id="${correlationId}"). ` +
								`Handle whatever the user needs now — you'll be prompted again when the response lands.`,
						}],
					};
				}

				const responseMsg = outcome.msg;
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
			"Prefer waiting for automatic notifications (<agent_idle>) over calling this tool. Notifications arrive without polling.",
			"Use only when you have a specific reason: diagnosing a suspected stall, answering a user question about progress, or checking usage mid-run.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent id to query. Omit for a summary of all active agents." })),

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
			"With an agent id: removes that single agent and returns an <agent_torn_down> report. Without: tears down all active agents and returns a <group_torn_down> summary with aggregate usage. The teardown report is slim for agents that already idled (the model already received their full <agent_idle> notification) — it surfaces session_id and a resurrection hint, but not the output. Agents torn down while still running include their last output/error so it isn't lost.",
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
				queue.drainLocal();
				ctx.ui.setWidget("subagents", undefined as any);
				dashboard = null;
				tuiRef = null;
				if (panelHandle) {
					panelHandle.clear();
					panelHandle = null;
				}
				skillPathsMap.clear();
			} else {
				refreshDisplays(manager.getAgentStatuses());
			}

			const label = params.agent ? `Agent "${params.agent}" removed.` : "All agents terminated.";
			return {
				content: [{ type: "text", text: `${label}\n\n${report}` }],
			};
		},
	});

	// ─── Tool: resurrect ─────────────────────────────────────────────────

	if (shouldRegisterTool("resurrect")) pi.registerTool({
		name: "resurrect",
		label: "Resurrect",
		description: "Bring a previously-torn-down subagent back online from its session file.",
		promptGuidelines: [
			"Revives one or more agents that were previously torn down — pass the `session_id` surfaced in a prior `<agent_idle>`, `<agent_torn_down>`, or `<group_torn_down>` report for each.",
			"Each resurrected agent inherits its persona, model, and tool set from the resumed session — none of those can be changed here. Only `id`, `channels`, and `task` are re-declared.",
			"Channels must be re-declared fresh because siblings from the prior generation may no longer exist. Parent is always implicitly available.",
			"To rebuild a mesh of agents that talked to each other, resurrect them in a single call: each agent may declare channels to its siblings in the same batch, since they all come online together.",
			"Resurrection is non-blocking — each agent picks up its new task and any prior conversation history is visible to it. Results arrive later as notifications, same as `subagent`/`fork`.",
		],
		parameters: Type.Object({
			agents: Type.Array(ResurrectItem, { description: "Agents to resurrect from their session files. Resurrect a whole mesh in one call so siblings can declare channels to each other." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mgr = ensureManager(ctx);

			if (params.agents.length === 0) {
				throw new Error("Empty agents array — provide at least one agent to resurrect.");
			}

			// Validate unique ids within the batch and against existing agents.
			assertNewAgentIds(params.agents.map((a) => a.id), mgr);

			// Reject reusing the same session twice in one batch.
			const sessionIds = params.agents.map((a) => a.sessionId);
			const dupeSessions = sessionIds.filter((s, i) => sessionIds.indexOf(s) !== i);
			if (dupeSessions.length > 0) {
				throw new Error(`Duplicate session ids in batch: ${[...new Set(dupeSessions)].join(", ")}`);
			}

			// Resolve and validate every agent atomically before starting any, so
			// a single bad entry doesn't leave a half-resurrected mesh.
			const specs: RegularAgentSpec[] = [];
			for (const a of params.agents) {
				const holder = mgr.findLiveHolder(a.sessionId);
				if (holder) {
					throw new Error(`Session ${a.sessionId} is currently held by live agent ${holder}; teardown that agent first or use a different one.`);
				}

				const resolved = mgr.resolveSessionFile(a.sessionId);
				if (!resolved) {
					const parentSessionFile = ctx.sessionManager.getSessionFile();
					const childSessionsDir = parentSessionFile
						? getPersistencePaths(parentSessionFile).childSessionsDir
						: undefined;
					if (!childSessionsDir || !fs.existsSync(childSessionsDir)) {
						throw new Error("No subagent infrastructure for this parent session — nothing to resurrect.");
					}
					throw new Error(`No session found with id ${a.sessionId}.`);
				}

				// Recover the original persona name from the persistence log so that
				// `start()` re-applies its tool restrictions (PI_PARENT_LINK.tools).
				// Tool gating lives in env, not in the resumed session bundle, so
				// without this the resurrected agent would silently get the full
				// default tool surface — contradicting the prompt guideline that
				// promises the resumed session's tool set is inherited.
				const persistedAgent = mgr.findPersistedAgentName(a.sessionId);

				specs.push({
					kind: "agent",
					id: a.id,
					agent: persistedAgent,
					task: a.task,
					channels: a.channels,
					resumeSessionFile: resolved,
				});
			}

			await ensureWidget(ctx);
			const ack = await mgr.start(specs, discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined).agents);
			await ensureParentBrokerClient();

			refreshDisplays(mgr.getAgentStatuses());

			stopSequences.addOnce("<agent_idle");

			return {
				content: [{ type: "text", text: ack }],
			};
		},
	});

	// ─── Tool: await_agents ──────────────────────────────────────────────

	if (shouldRegisterTool("await_agents")) pi.registerTool({
		name: "await_agents",
		label: "Await Agents",
		description: "Block until an agent completes or sends a message. Returns accumulated notifications.",
		promptGuidelines: [
			"Use `await_agents` when you need results before your next step — it blocks until all specified agents complete (or all agents, if none specified).",
			"Any agent message (including fire-and-forget) interrupts the wait. If an expect-response message interrupts, you must call `respond` before waiting again.",
			"After handling an interruption, call `await_agents` again to resume waiting.",
		],
		parameters: Type.Object({
			agents: Type.Optional(
				Type.Array(Type.String(), {
					description: "Agent IDs to wait on. Omit to wait on all active agents.",

				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!manager || !manager.hasAgents()) {
				throw new Error("No agents running. Spawn agents first with the subagent or fork tool.");
			}

			// Validate agent IDs if scoped
			if (params.agents) {
				if (params.agents.length === 0) {
					throw new Error("Empty agents array. Omit the parameter to wait on all agents.");
				}
				for (const id of params.agents) {
					if (!manager.getAgentStatus(id)) {
						throw new Error(`Unknown agent: "${id}"`);
					}
				}
			}

			const scopedIds = params.agents ?? manager.getAgentStatuses().map((s) => s.id);
			const waitResult = await awaitAgentCompletion(scopedIds, manager, signal);
			return {
				content: [{ type: "text", text: waitResult }],
			};
		},
	});

	// ─── Tool: interrupt ─────────────────────────────────────────────────

	if (shouldRegisterTool("interrupt")) pi.registerTool({
		name: "interrupt",
		label: "Interrupt",
		description: "Halt a subagent immediately without tearing it down. Interrupts any in-flight tool call — useful when one is hung or stuck.",
		promptGuidelines: [
			"Forces the worker idle as fast as possible, short of teardown. Interrupts any running tool call — use when one is hung or stuck.",
			"Prefer `send` unless you realize (usually because the user pointed it out) the subagent is going wrong and must be stopped now.",
			"Also use it when the user reports a hung tool call and you want to unstick the subagent without tearing it down, so you can get it going again.",
		],
		parameters: Type.Object({
			agents: Type.Optional(
				Type.Array(Type.String(), {
					description: "Agent IDs to interrupt. Omit to interrupt all active agents.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!manager || !manager.hasAgents()) {
				throw new Error("No agents running. Spawn agents first with the subagent or fork tool.");
			}

			if (params.agents) {
				if (params.agents.length === 0) {
					throw new Error("Empty agents array. Omit the parameter to interrupt all agents.");
				}
				for (const id of params.agents) {
					if (!manager.getAgentStatus(id)) {
						throw new Error(`Unknown agent: "${id}"`);
					}
				}
			}

			const scopedIds = params.agents ?? manager.getAgentStatuses().map((s) => s.id);
			const results = await Promise.allSettled(scopedIds.map((id) => manager!.interrupt(id)));

			const interrupted: string[] = [];
			const failed: string[] = [];
			results.forEach((r, i) => {
				if (r.status === "fulfilled") interrupted.push(scopedIds[i]);
				else failed.push(`${scopedIds[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
			});

			const lines: string[] = [];
			if (interrupted.length > 0) lines.push(`Interrupted: ${interrupted.join(", ")}`);
			if (failed.length > 0) lines.push(`Failed: ${failed.join("; ")}`);
			return {
				content: [{ type: "text", text: lines.join("\n") || "No agents interrupted." }],
			};
		},
	});

	// ─── Cleanup on shutdown ─────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		// Always tear down OS resources. Pi reloads extensions with jiti
		// `moduleCache: false`, so the new module instance gets fresh closures
		// (`manager`, `brokerClient`, etc. all `null` again). Without an explicit
		// SIGTERM here, the spawned `pi` RPC children would only die when GC
		// eventually finalizes their `ChildProcess` refs in the dead module —
		// racy, and during the window the new module's `restoreFromPersistence`
		// has already spawned duplicates. `softShutdown()` SIGTERMs each child
		// and stops the broker but leaves the persistence log intact so the next
		// `session_start` can re-spawn the same logical agents via
		// `restoreFromPersistence`.
		queue.clear();
		if (manager) {
			await manager.softShutdown();
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
		if (panelHandle) {
			panelHandle.clear();
			panelHandle = null;
		}
		skillPathsMap.clear();
	});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAgentStatusSummary(s: import("./agent-set.js").AgentStatus): string {
	const icon = { running: "⏳", idle: "✓", failed: "✗", waiting: "⏸" }[s.state];
	const usage = s.usage.cost > 0 ? ` ($${s.usage.cost.toFixed(4)})` : "";
	return `${icon} ${s.id}: ${s.state}${s.lastActivity ? ` — ${s.lastActivity}` : ""}${usage}`;
}

// ─── Panel card mapping ──────────────────────────────────────────────────────

const STATE_COLORS: Record<AgentState, CardColor> = {
	running: "accent",
	idle: "success",
	waiting: "warning",
	failed: "error",
};

const STATE_LABELS: Record<AgentState, string> = {
	running: "running",
	idle: "idle",
	waiting: "waiting",
	failed: "failed",
};

function statusesToCards(statuses: AgentStatus[]): Card[] {
	return statuses.map((s) => {
		const body: Card["body"] = [];

		// Agent def + model
		const defName = s.agentDef || "default";
		const modelName = s.model || "—";
		body.push({ content: `${defName} · ${modelName}`, style: "secondary" });

		// Activity
		if (s.state === "running" && s.lastActivity) {
			body.push({ content: s.lastActivity, style: "text" });
		} else if (s.state === "waiting") {
			body.push({ content: `waiting → ${s.waitingFor.join(", ") || "?"}`, style: "text" });
		}

		// Channels
		if (s.channels.length > 0) {
			body.push({ content: s.channels.join(" · "), style: "secondary" });
		}

		// Footer stats
		const footer: string[] = [];
		const totalInput = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite;
		if (totalInput > 0) footer.push(`↑${formatTokenCount(totalInput)}`);
		if (s.usage.output > 0) footer.push(`↓${formatTokenCount(s.usage.output)}`);
		if (s.contextWindow && s.contextWindow > 0 && s.lastTurnInput > 0) {
			footer.push(`ctx:${Math.round((s.lastTurnInput / s.contextWindow) * 100)}%`);
		}
		if (s.usage.cost > 0) footer.push(`$${s.usage.cost.toFixed(2)}`);

		// Build tag: "running (3)" or "running (3) 󰚩"
		let tag = STATE_LABELS[s.state];
		if (s.usage.turns > 0) tag += ` (${s.usage.turns})`;
		if (s.hasSubgroup) tag += " \uDB81\uDEA9";

		return {
			id: s.id,
			color: STATE_COLORS[s.state],
			header: {
				title: s.id,
				tag,
			},
			body,
			footer,
		};
	});
}

function formatAgentStatusDetail(s: import("./agent-set.js").AgentStatus): string {
	const lines = [
		`Agent: ${s.id}`,
		`State: ${s.state}`,
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
