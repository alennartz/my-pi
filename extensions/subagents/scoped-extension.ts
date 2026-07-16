/**
 * Scoped in-process subagents extension.
 *
 * Each factory invocation owns only one session scope. Root factories create a
 * registry lazily from their host context; child factories receive their
 * registry, path, identity, and parent port explicitly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detect } from "@pimote/panels";
import type { PanelHandle, Card, CardColor } from "@pimote/panels";

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
import { SubagentManager, type AgentStatus, type AgentState } from "./agent-set.js";
import {
	AgentSessionRegistry,
	type AgentOperationalSnapshot,
} from "./agent-session-registry.js";
import type { AgentPath } from "./agent-path.js";
import { getPersistencePaths } from "./persistence.js";
import { serializeAgentComplete, serializeAgentMessage, type AgentCompleteData } from "./messages.js";
import { createStopSequenceManager, type StopSequenceManager } from "./stop-sequences.js";
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
import type { MessagePort, RoutedMessage, RoutedResponse } from "./message-router.js";

const USE_STEER_DELIVERY = true;

/** Identity and communication scope injected into a child session. */
export type SubagentScope =
	| { kind: "root" }
	| {
			kind: "child";
			registry: AgentSessionRegistry;
			path: AgentPath;
			identity: {
				id: string;
				task: string;
				channels: string[];
			};
			uplink: MessagePort;
		};

function emptyOperational(state: AgentOperationalSnapshot["state"] = "idle"): AgentOperationalSnapshot {
	return {
		state,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		lastTurnInput: 0,
		hasSubgroup: false,
		pendingCorrelations: [],
		waitingFor: [],
	};
}

function stableRootSessionId(ctx: ExtensionContext, sessionFile: string | undefined): string {
	const getSessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId;
	const id = getSessionId?.call(ctx.sessionManager);
	if (id) return id;
	if (sessionFile) return path.basename(sessionFile, path.extname(sessionFile));
	return ctx.sessionManager.getSessionName?.() ?? "root";
}

/** Build an extension factory bound to one root or child session scope. */
export function createSubagentsExtension(scope: SubagentScope): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let manager: SubagentManager | null = null;
		let registry: AgentSessionRegistry | null = scope.kind === "child" ? scope.registry : null;
		let registryUnsubscribe: (() => void) | null = null;
		let uplinkUnsubscribe: (() => void) | null = null;
		let dashboard: {
			update(statuses: AgentStatus[]): void;
			setSessionName(name: string | undefined): void;
		} | null = null;
		let panelHandle: PanelHandle | null = null;
		let tuiRef: { requestRender(): void } | null = null;
		let stopSequences: StopSequenceManager | null = null;
		let rootOperational = emptyOperational("idle");
		let rootRunError: string | undefined;
		const skillPathsMap = new Map<string, string[]>();
		const notifiedTierIssues = new Set<string>();
		// A recursive scope has two routing ports: its local parent endpoint and
		// the explicit uplink to its own parent. Generated IDs are namespaced, but
		// callers may provide explicit IDs. Keep one origin and reject a duplicate
		// arriving on the other port before it reaches the model.
		const correlationOrigin = new Map<string, MessagePort>();
		let cachedPackageAgents: { user: AgentConfig[]; project: AgentConfig[] } | null = null;

		const queue = new NotificationQueue({
			steerDelivery: USE_STEER_DELIVERY,
			deliver(combined: string) {
				// Messages queued while the host is idle must start a turn. Without
				// triggerTurn the SDK only appends the custom message and blocking
				// sends to an idle child can remain pending forever.
				pi.sendMessage({ customType: "subagents", content: combined, display: true, triggerTurn: true });
			},
		});

		interface WaitState {
			resolve: (result: string) => void;
			satisfied: () => boolean;
			abortCleanup: (() => void) | null;
		}
		let waitState: WaitState | null = null;

		const AgentItem = Type.Object({
			id: Type.String({ description: "Unique identifier for this agent among the parent's active agents" }),
			agent: Type.Optional(Type.String({ description: "Agent definition name (omit for default agent)" })),
			model: Type.Optional(Type.String({ description: "Optional model override: a tier name (`cheap`, `medium`, `smart`, `frontier`) or a concrete model id. Ignored if the selected specialist agent definition already pins a model." })),
			task: Type.String({ description: "Task description for this agent" }),
			channels: Type.Optional(Type.Array(Type.String(), {
				description: "Peer agent ids this agent can send to (agent-to-agent only; parent is always allowed)",
			})),
			cwd: Type.Optional(Type.String({
				description:
					"Working directory for this agent. Relative paths resolve against the parent's cwd. " +
					"Defaults to the parent's cwd. The subagent boots as if pi were freshly launched in this directory — " +
					"its AGENTS.md, project agents, and project skills are discovered relative to it.",
			})),
		});

		const ResurrectItem = Type.Object({
			id: Type.String({ description: "Unique identifier for the resurrected agent among the parent's active agents" }),
			sessionId: Type.String({ description: "session_id surfaced by a prior teardown report" }),
			channels: Type.Array(Type.String(), { description: "Peer agent ids this agent can send to (re-declared fresh; siblings resurrected in the same batch are valid targets). Parent is always allowed." }),
			task: Type.String({ description: "Directive the agent runs on resurrection" }),
		});

		function loadTiers(cwd: string, projectTrusted: boolean): TierConfig {
			return loadTierConfig({
				globalPath: path.join(getAgentDir(), "model-tiers.json"),
				projectPath: path.join(cwd, ".pi", "model-tiers.json"),
				projectTrusted,
			});
		}

		function notifyTierIssueOnce(
			ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
			message: string,
		): void {
			if (notifiedTierIssues.has(message)) return;
			notifiedTierIssues.add(message);
			ctx.ui.notify(message, "warning");
		}

		function ensureRootRegistry(ctx: ExtensionContext): AgentSessionRegistry {
			if (scope.kind === "child") return scope.registry;
			if (registry) return registry;
			const sessionFile = ctx.sessionManager.getSessionFile();
			registry = new AgentSessionRegistry({
				root: {
					path: [],
					parentPath: null,
					localId: null,
					ownership: "external",
					sessionId: stableRootSessionId(ctx, sessionFile),
					...(sessionFile ? { sessionFile } : {}),
					cwd: (ctx.sessionManager as { getCwd?: () => string }).getCwd?.() ?? ctx.cwd,
					channels: [],
					operational: rootOperational,
				},
				dependencies: {
					agentDir: getAgentDir(),
					authStorage: ctx.modelRegistry.authStorage,
					modelRegistry: ctx.modelRegistry,
				},
			});
			return registry;
		}

		function updateRootOperational(ctx: ExtensionContext | undefined, patch: Partial<AgentOperationalSnapshot>): void {
			if (scope.kind !== "root") return;
			const activeRegistry = registry ?? (ctx ? ensureRootRegistry(ctx) : null);
			const canonical = activeRegistry?.getSnapshot([])?.operational;
			const base = canonical ?? rootOperational;
			rootOperational = {
				...base,
				...patch,
				usage: patch.usage ?? base.usage,
				pendingCorrelations: patch.pendingCorrelations ?? base.pendingCorrelations,
				waitingFor: patch.waitingFor ?? base.waitingFor,
			};
			activeRegistry?.updateOperational([], rootOperational);
		}

		function refreshDisplays(statuses: AgentStatus[]): void {
			if (dashboard && tuiRef) {
				dashboard.update(statuses);
				tuiRef.requestRender();
			}
			if (panelHandle) panelHandle.updateCards(statusesToCards(statuses));
		}

		function assertNewAgentIds(ids: string[], mgr: SubagentManager): void {
			const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
			if (dupes.length > 0) throw new Error(`Duplicate agent ids: ${[...new Set(dupes)].join(", ")}`);
			const existingIds = new Set(mgr.getAgentStatuses().map((status) => status.id));
			for (const id of ids) {
				if (existingIds.has(id)) throw new Error(`Agent id "${id}" already exists`);
			}
		}

		function resolveWait(): void {
			if (!waitState) return;
			const state = waitState;
			waitState = null;
			state.abortCleanup?.();
			queue.setWaiting(false);
			state.resolve(queue.drainAll());
		}

		async function awaitAgentCompletion(ids: string[], mgr: SubagentManager, signal?: AbortSignal | null): Promise<string> {
			const isSatisfied = () => ids.every((id) => {
				const status = mgr.getAgentStatus(id);
				return !status || status.state === "idle" || status.state === "failed";
			});
			if (isSatisfied()) {
				const result = queue.drainAll();
				return result || "All specified agents have already completed. No pending notifications.";
			}
			if (waitState) throw new Error("Another await_agents call is already active.");
			queue.setWaiting(true);
			try {
				const result = await new Promise<string>((resolve, reject) => {
					const state: WaitState = { resolve, satisfied: isSatisfied, abortCleanup: null };
					waitState = state;
					if (!signal) return;
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
				});
				return result || "All specified agents have completed. No pending notifications.";
			} catch (error: any) {
				if (error?.message === "Aborted") throw new Error("Wait cancelled.");
				throw error;
			}
		}

		function getLocalParentPort(): MessagePort | null {
			const candidate = (manager as any)?.getParentPort?.()
				?? (manager as any)?.parentPort
				?? (manager as any)?.getRouterPort?.("parent");
			return candidate && typeof candidate.send === "function" ? candidate as MessagePort : null;
		}

		function rejectDuplicateCorrelation(port: MessagePort, correlationId: string): void {
			const error = `Correlation ID "${correlationId}" is already pending on another recursive route`;
			if (port.reject) {
				void port.reject(correlationId, error).catch(() => {});
				return;
			}
			// Structural adapters from the pre-rejection interface only expose
			// respond(); the typed router path above is used in production.
			void port.respond(correlationId, `(no response — ${error})`).catch(() => {});
		}

		function rememberCorrelationOrigin(correlationId: string, port: MessagePort): boolean {
			const existing = correlationOrigin.get(correlationId);
			if (existing && existing !== port) {
				rejectDuplicateCorrelation(port, correlationId);
				return false;
			}
			correlationOrigin.set(correlationId, port);
			return true;
		}

		function receiveRoutedMessage(port: MessagePort, message: RoutedMessage, source: "local" | "uplink"): void {
			if (message.responseExpected && message.correlationId && !rememberCorrelationOrigin(message.correlationId, port)) {
				return;
			}
			queue.queue(serializeAgentMessage({
				from: message.from,
				content: message.message,
				correlationId: message.correlationId,
				responseExpected: message.responseExpected,
			}), source);
			if (queue.isWaiting) resolveWait();
		}

		function ensureManager(ctx: ExtensionContext): SubagentManager {
			if (manager) return manager;
			const ownerPath: AgentPath = scope.kind === "child" ? scope.path : [];
			const activeRegistry = scope.kind === "child" ? scope.registry : ensureRootRegistry(ctx);
			manager = new SubagentManager({
				pi,
				cwd: ctx.cwd,
				registry: activeRegistry,
				ownerPath,
				parentSessionFile: ctx.sessionManager.getSessionFile(),
				skillPaths: skillPathsMap,
				resolveContextWindow: (modelId: string) => {
					const found = ctx.modelRegistry.getAvailable().find((model: any) =>
						model?.id === modelId || `${model?.provider}/${model?.id}` === modelId,
					);
					return found?.contextWindow;
				},
				onUpdate: (current) => refreshDisplays(current.getAgentStatuses()),
				onAgentComplete: (current, agentId, allDone) => {
					const status = current.getAgentStatus(agentId);
					if (!status) return;
					const data: AgentCompleteData = {
						id: agentId,
						status: status.state === "failed" ? "failed" : "idle",
						output: status.lastOutput,
						error: status.state === "failed" ? (status.lastError || "Agent failed") : undefined,
					};
					let xml = serializeAgentComplete(data);
					if (allDone) {
						const total = current.getAgentStatuses().length;
						xml += `\n\nAll ${total} agent${total === 1 ? "" : "s"} are now idle. Use send to ask questions or continue their work. When you're done with them, call teardown to clean up.`;
					}
					queue.queue(xml, "local");
					if (queue.isWaiting && waitState?.satisfied()) resolveWait();
				},
				onParentMessage: (xml, meta) => {
					const port = getLocalParentPort();
					if (meta.responseExpected && meta.correlationId && port && !rememberCorrelationOrigin(meta.correlationId, port)) {
						return;
					}
					queue.queue(xml, "local");
					if (queue.isWaiting) resolveWait();
				},
			});
			const subscribe = (activeRegistry as any).subscribe;
			if (typeof subscribe === "function") {
				registryUnsubscribe = subscribe.call(activeRegistry, (event: any) => {
					const node = event.node;
					if (!node?.parentPath || node.parentPath.length !== ownerPath.length) return;
					if (!node.parentPath.every((segment: string, index: number) => segment === ownerPath[index])) return;
					refreshDisplays(manager?.getAgentStatuses() ?? []);
				});
			}
			return manager;
		}

		async function ensureWidget(ctx: ExtensionContext): Promise<void> {
			if (scope.kind === "child" || dashboard || panelHandle) return;
			if (ctx.mode === "tui") {
				const initialName = ctx.sessionManager.getSessionName?.();
				// Structural extension tests deliberately run without Pi's optional TUI
				// package. Defer the widget module until a UI is actually requested so
				// tool registration remains loader-safe; the fallback keeps headless
				// adapters functional if that optional presentation dependency is absent.
				let Dashboard: new (theme: unknown) => NonNullable<typeof dashboard>;
				try {
					({ SubagentDashboard: Dashboard } = await import("./widget.js") as any);
				} catch {
					Dashboard = class {
						update(_statuses: AgentStatus[]): void {}
						setSessionName(_name: string | undefined): void {}
					} as any;
				}
				ctx.ui.setWidget("subagents", (tui, theme) => {
					tuiRef = tui;
					dashboard = new Dashboard(theme);
					dashboard.setSessionName(initialName);
					return dashboard as any;
				});
			} else {
				panelHandle = detect(pi, "subagents");
			}
		}

		function clearDisplays(ctx?: ExtensionContext): void {
			if (scope.kind === "root") ctx?.ui.setWidget("subagents", undefined as any);
			dashboard = null;
			tuiRef = null;
			if (panelHandle) {
				panelHandle.clear();
				panelHandle = null;
			}
		}

		function terminalError(event: any): string | undefined {
			if (event?.willRetry) return undefined;
			const messages = Array.isArray(event?.messages) ? event.messages : [];
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				const message = messages[index];
				if (message?.role !== "assistant") continue;
				return message.stopReason === "error" ? (message.errorMessage || "Agent run ended with an error") : undefined;
			}
			return undefined;
		}

		function projectRootMessage(event: any, ctx: ExtensionContext): void {
			const message = event?.message;
			if (message?.role !== "assistant") return;
			const usage = message.usage;
			const canonical = registry?.getSnapshot([])?.operational;
			if (canonical) rootOperational = canonical;
			const prior = rootOperational.usage;
			const nextUsage = {
				input: prior.input + (usage?.input || 0),
				output: prior.output + (usage?.output || 0),
				cacheRead: prior.cacheRead + (usage?.cacheRead || 0),
				cacheWrite: prior.cacheWrite + (usage?.cacheWrite || 0),
				cost: prior.cost + (usage?.cost?.total || 0),
				turns: prior.turns + 1,
			};
			let lastOutput = rootOperational.lastOutput;
			for (const part of message.content ?? []) {
				if (part.type === "text") lastOutput = part.text;
			}
			const model = message.model ?? rootOperational.model;
			const modelInfo = ctx.modelRegistry.getAvailable().find((candidate: any) =>
				candidate?.id === model || `${candidate?.provider}/${candidate?.id}` === model,
			);
			updateRootOperational(ctx, {
				usage: nextUsage,
				model,
				contextWindow: modelInfo?.contextWindow ?? rootOperational.contextWindow,
				lastTurnInput: (usage?.input || 0) + (usage?.cacheRead || 0) + (usage?.cacheWrite || 0),
				lastOutput,
			});
		}

		function registerTools(): void {
	// ─── Tool: list_models ──────────────────────────────────────────────────────

	pi.registerTool({
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

	pi.registerTool({
		name: "subagent",
		label: "Subagents",
		description: "Spawn specialized subagents with channel-based inter-agent communication.",
		promptGuidelines: [
			"Spawns agents that run in parallel with isolated contexts. Non-blocking — returns immediately with an acknowledgment. Live status shown in the widget.",
			"Each agent gets its own isolated pi SDK session. Agents communicate via the send/respond tools using channels declared at spawn time.",
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
			// any invalid cwd before any child session is constructed.
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
			// so the child session gets an unambiguous model ref. resolveCliModel in
			// the child runtime uses getAll() + find() (first match), which picks built-in
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

			// Push initial statuses so the widget renders immediately
			refreshDisplays(mgr.getAgentStatuses());

			stopSequences?.addOnce("<agent_idle");

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


	pi.registerTool({
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

			// Capture every active SDK tool. The manager resolves the normalized child
			// policy (including ask_user exclusion and infrastructure respond).
			const tools = [...pi.getActiveTools()];

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

			// Push initial statuses
			refreshDisplays(mgr.getAgentStatuses());

			stopSequences?.addOnce("<agent_idle");

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

	pi.registerTool({
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

			const isLocalAgent = manager?.getAgentStatus(params.to) !== undefined;
			const port = isLocalAgent
				? getLocalParentPort()
				: scope.kind === "child"
					? scope.uplink
					: null;
			if (!port) {
				throw new Error(
					manager
						? `No route to agent "${params.to}".`
						: "No agents running. Spawn agents first with the subagent or fork tool.",
				);
			}

			const receipt = await port.send({
				to: params.to,
				message: params.message,
				expectResponse: params.expectResponse,
			});
			if (!params.expectResponse) {
				return { content: [{ type: "text", text: `Message sent to ${params.to}.` }] };
			}

			const correlationId = receipt.correlationId;
			const responsePromise = receipt.response;
			if (!correlationId || !responsePromise) {
				throw new Error("Message route did not provide a blocking response handle");
			}

			const source: "local" | "uplink" = scope.kind === "child" && port === scope.uplink
				? "uplink"
				: "local";
			const deliverDeferredResponse = (response: RoutedResponse) => {
				const content = response.type === "response"
					? response.message
					: `(no response — ${response.error})`;
				queue.queue(serializeAgentMessage({
					from: params.to,
					content,
					correlationId,
					responseExpected: false,
				}), source);
				if (queue.isWaiting) resolveWait();
			};

			type RaceResult = { kind: "response"; response: RoutedResponse } | { kind: "deferred" };
			const outcome = await new Promise<RaceResult>((resolve, reject) => {
				let settled = false;
				const detach = () => {
					if (settled) return;
					settled = true;
					// Detach only removes the caller's waiting edge. The accepted
					// correlation remains live so its eventual response is surfaced
					// as a normal asynchronous agent message.
					port.detach(correlationId);
					resolve({ kind: "deferred" });
				};
				const onAbort = () => detach();
				if (signal?.aborted) detach();
				else signal?.addEventListener("abort", onAbort, { once: true });

				responsePromise.then(
					(response) => {
						signal?.removeEventListener("abort", onAbort);
						if (settled) {
							deliverDeferredResponse(response);
							return;
						}
						settled = true;
						resolve({ kind: "response", response });
					},
					(error) => {
						signal?.removeEventListener("abort", onAbort);
						if (settled) {
							queue.queue(serializeAgentMessage({
								from: params.to,
								content: `(no response — ${error instanceof Error ? error.message : String(error)})`,
								correlationId,
								responseExpected: false,
							}), source);
							if (queue.isWaiting) resolveWait();
							return;
						}
						settled = true;
						reject(error);
					},
				);
			});

			if (outcome.kind === "deferred") {
				return {
					content: [{
						type: "text",
						text:
							`Your blocking wait on "${params.to}" was interrupted, not cancelled. ` +
							`"${params.to}" is still working; its reply will arrive later as an ` +
							`<agent_message> notification (correlation_id="${correlationId}"). ` +
							"Handle whatever the user needs now — you'll be prompted again when the response lands.",
					}],
				};
			}
			if (outcome.response.type === "response") {
				return { content: [{ type: "text", text: outcome.response.message }] };
			}
			throw new Error(outcome.response.error);
		}
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
			const port = correlationOrigin.get(params.correlationId)
				?? (scope.kind === "child" ? scope.uplink : getLocalParentPort());
			if (!port) throw new Error("No route for this response.");
			await port.respond(params.correlationId, params.message);
			correlationOrigin.delete(params.correlationId);
			return { content: [{ type: "text", text: "Response sent." }] };
		}
	});

	// ─── Tool: check_status ──────────────────────────────────────────────

	pi.registerTool({
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

	pi.registerTool({
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
				// The manager has removed only its immediate children. Runtime ownership
				// remains in the shared registry until each removal completes.
				registryUnsubscribe?.();
				registryUnsubscribe = null;
				manager = null;
				queue.drainLocal();
				clearDisplays(ctx);
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

	pi.registerTool({
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

				// Recover the original persona name from the lifecycle log so the
				// manager can reconstruct its normalized child tool policy on resume.
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

			refreshDisplays(mgr.getAgentStatuses());

			stopSequences?.addOnce("<agent_idle");

			return {
				content: [{ type: "text", text: ack }],
			};
		},
	});

	// ─── Tool: await_agents ──────────────────────────────────────────────

	pi.registerTool({
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

	pi.registerTool({
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


		}

		// Structural loaders may provide only registerTool. Tool registration must
		// remain usable before lifecycle wiring, while an explicit child uplink
		// remains usable independently of host lifecycle hooks.
		registerTools();
		if (scope.kind === "child" && typeof scope.uplink.subscribe === "function") {
			uplinkUnsubscribe = scope.uplink.subscribe((message) =>
				receiveRoutedMessage(scope.uplink, message, "uplink"),
			);
		}
		if (typeof (pi as any).on !== "function") return;

		stopSequences = createStopSequenceManager(pi);

		pi.on("agent_start", async (_event, ctx) => {
			queue.setParentBusy(true);
			if (scope.kind === "root") {
				rootRunError = undefined;
				updateRootOperational(ctx, { state: "running", lastError: undefined });
			}
		});

		pi.on("agent_end", async (event, ctx) => {
			queue.clearPendingTools();
			if (scope.kind === "root") {
				const error = terminalError(event);
				if (error) {
					rootRunError = error;
					updateRootOperational(ctx, { lastError: error });
				}
			}
		});

		pi.on("agent_settled", async (_event, ctx) => {
			queue.setParentBusy(false);
			if (scope.kind === "root") {
				updateRootOperational(ctx, {
					state: rootRunError ? "failed" : "idle",
					lastActivity: undefined,
				});
			}
		});

		pi.on("message_end", async (event, ctx) => {
			if (scope.kind === "root") projectRootMessage(event, ctx);
		});

		pi.on("session_info_changed", async (event) => {
			if (!dashboard || !tuiRef) return;
			dashboard.setSessionName(event.name);
			tuiRef.requestRender();
		});

		if (USE_STEER_DELIVERY) {
			pi.on("tool_execution_start", async (event, ctx) => {
				queue.trackToolStart(event.toolCallId);
				if (scope.kind === "root") {
					const raw = event as any;
					const toolName = raw.toolName ?? raw.tool?.name;
					updateRootOperational(ctx, {
						lastActivity: toolName ? `${toolName}(${summarizeArgs(raw.args ?? raw.input ?? {})})`.replace(/[\r\n]+/g, " ") : rootOperational.lastActivity,
						hasSubgroup: toolName === "subagent" || toolName === "fork"
							? true
							: toolName === "teardown"
								? false
								: rootOperational.hasSubgroup,
					});
				}
			});
			pi.on("tool_execution_end", async (event) => {
				queue.trackToolEnd(event.toolCallId);
			});
		}

		pi.on("session_start", async (event, ctx) => {
			try {
				cachedPackageAgents = await discoverPackageAgents(ctx.cwd);
			} catch {
				cachedPackageAgents = null;
			}
			if (scope.kind === "child") return;
			ensureRootRegistry(ctx);
			if (event.reason === "new" || event.reason === "fork") return;
			const current = ensureManager(ctx);
			const discovery = discoverAgents(ctx.cwd, cachedPackageAgents ?? undefined);
			await current.restoreFromPersistence(discovery.agents);
			if (!current.hasAgents()) return;
			await ensureWidget(ctx);
			refreshDisplays(current.getAgentStatuses());
			stopSequences?.addOnce("<agent_idle");
		});

		pi.on("before_agent_start", async (event, ctx) => {
			if (!pi.getActiveTools().includes("subagent")) return;
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
				for (const agent of agents) lines.push(`- **${agent.name}** (${agent.source}): ${agent.description}`);
				lines.push("");
			}
			const availableModels: any[] = ctx.modelRegistry.getAvailable();
			const isAvailable = (ref: string) => availableModels.some((model: any) =>
				model?.id === ref || `${model?.provider}/${model?.id}` === ref,
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
				"Raw model IDs are also accepted in `agents[].model` when the user names a specific model; `list_models` shows the full catalog.",
				"Append a thinking-effort suffix to any model id with `:<level>` (levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) — e.g. `anthropic/claude-opus-4-8:xhigh`. Tier names don't take a suffix; a tier carries whatever level its config encodes.",
				"",
				"Omitting the `agent` field spawns a **default general-purpose agent** — use this unless the task specifically matches a specialist's description above. You may set `model` to override model selection unless the chosen specialist agent definition already pins a model.",
				"",
				"Omit `model` entirely by default — subagents then inherit the session's model. Specify a tier only when the user asks for one.",
				"",
			);
			return { systemPrompt: event.systemPrompt + "\n" + lines.join("\n") + "\n" };
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			queue.clear();
			waitState?.abortCleanup?.();
			waitState = null;
			uplinkUnsubscribe?.();
			uplinkUnsubscribe = null;
			registryUnsubscribe?.();
			registryUnsubscribe = null;
			if (manager) {
				await manager.softShutdown();
				manager = null;
			}
			correlationOrigin.clear();
			clearDisplays(ctx);
			skillPathsMap.clear();
			stopSequences?.clear();
			if (scope.kind === "root") {
				const ownedRegistry = registry;
				registry = null;
				await ownedRegistry?.dispose();
			}
		});
	};
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
