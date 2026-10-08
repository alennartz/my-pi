import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerLooseTool } from "../../lib/tool-args.ts";
import { detect } from "@pimote/sdk/panels";
import type { PanelHandle } from "@pimote/sdk/panels";
import {
	getOrCreateSessionTreeStore,
	registerSessionTreeStore,
	unregisterSessionTreeStore,
} from "./scoped-store.js";
import {
	type AgentConfig,
	type RegularAgentSpec,
	type ForkAgentSpec,
	discoverAgents,
	discoverPackageAgents,
	resolveSkillPaths,
	resolveAgentCwds,
	formatAgentList,
	renderAgentDefinitions,
} from "./agents.js";
import { SubagentManager, isSettledState, loadActivePersona, type AgentStatus } from "./agent-set.js";
import {
	AgentSessionRegistry,
	type AgentOperationalSnapshot,
	type RegistryEvent,
} from "./agent-session-registry.js";
import type { AgentPath } from "./agent-path.js";
import { getPersistencePaths } from "./persistence.js";
import { serializeAgentComplete, serializeAgentMessage, type AgentCompleteData } from "./messages.js";
import { createStopSequenceManager, type StopSequenceManager } from "./stop-sequences.js";
import { NotificationQueue } from "./notification-queue.js";
import { statusesToCards } from "./panel-cards.js";
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
const FORCED_MODEL_KEY = "forced-model";

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

interface SessionEnvironment {
	readonly packageAgents: { readonly user: readonly AgentConfig[]; readonly project: readonly AgentConfig[] } | null;
	readonly cachedModels: readonly { readonly provider: string; readonly id: string }[];
	readonly modelCatalog: readonly {
		readonly provider?: string;
		readonly id?: string;
		readonly contextWindow?: number;
	}[];
	discoverAgents(cwd: string): ReturnType<typeof discoverAgents>;
	resolveContextWindow(modelId: string): number | undefined;
}

interface ActiveSubagentSession {
	readonly environment: SessionEnvironment;
	readonly registry: AgentSessionRegistry;
	readonly manager: SubagentManager;
	readonly presentation: SubagentPresentation;
	readonly turns: SessionTurnCoordinator;
	readonly incomingMessages: IncomingMessageState;
}

type SessionPhase =
	| { kind: "before-start" }
	| { kind: "starting" }
	| { kind: "active"; session: ActiveSubagentSession }
	| { kind: "shutting-down" };

interface WaitState {
	resolve: (result: string) => void;
	satisfied: () => boolean;
	abortCleanup: (() => void) | null;
}

function createSessionEnvironment(
	packageAgents: { user: AgentConfig[]; project: AgentConfig[] } | null,
	models: any[],
): SessionEnvironment {
	const frozenPackages = packageAgents
		? Object.freeze({
			user: Object.freeze([...packageAgents.user]),
			project: Object.freeze([...packageAgents.project]),
		})
		: null;
	const modelCatalog = Object.freeze(models.map((model) => Object.freeze({
		provider: typeof model?.provider === "string" ? model.provider : undefined,
		id: typeof model?.id === "string" ? model.id : undefined,
		contextWindow: typeof model?.contextWindow === "number" ? model.contextWindow : undefined,
	})));
	const cachedModels: readonly { provider: string; id: string }[] = Object.freeze(modelCatalog
		.filter((model) => Boolean(model.provider && model.id))
		.map((model) => Object.freeze({ provider: model.provider!, id: model.id! })));
	return Object.freeze({
		packageAgents: frozenPackages,
		cachedModels,
		modelCatalog,
		discoverAgents(cwd: string) {
			const packageSnapshot = frozenPackages
				? { user: [...frozenPackages.user], project: [...frozenPackages.project] }
				: undefined;
			return discoverAgents(cwd, packageSnapshot);
		},
		resolveContextWindow(modelId: string) {
			return modelCatalog.find((model) =>
				model.id === modelId || `${model.provider}/${model.id}` === modelId,
			)?.contextWindow;
		},
	});
}

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

/** Model reference for inheriting the active parent session model. */
function modelRefOf(model: { provider?: unknown; id?: unknown } | undefined): string | undefined {
	if (typeof model?.id !== "string" || model.id.length === 0) return undefined;
	if (typeof model.provider === "string" && model.provider.length > 0) {
		return `${model.provider}/${model.id}`;
	}
	return model.id;
}

/** True when `ref` names an available model by bare id or `provider/id`. */
function isAvailableModelRef(ref: string, availableModels: readonly any[]): boolean {
	return availableModels.some(
		(candidate: any) => candidate?.id === ref || `${candidate?.provider}/${candidate?.id}` === ref,
	);
}

/** The "Unknown model" error text for a rejected winning reference. */
function unknownModelMessage(modelPart: string, agentId: string, availableModels: readonly any[]): string {
	const available = availableModels
		.map((model: any) => `${model?.provider}/${model?.id}`)
		.filter(Boolean)
		.sort();
	const preview = available.length > 0 ? available.slice(0, 20).join(", ") : "none";
	const more = available.length > 20 ? `, ... (+${available.length - 20} more)` : "";
	return `Unknown model "${modelPart}" for agent "${agentId}". Tiers: ${TIER_NAMES.join(", ")}. Available models: ${preview}${more}`;
}

/**
 * Resolve one child construction's winning model reference.
 *
 * Precedence: the active persona's `model` pin wins outright; the explicit
 * tool `model` is gap-filling only (it applies when the active persona
 * declares no `model`); otherwise the parent-inherited baseline stands. Only
 * the winner is validated and resolved — a discarded reference is never
 * consulted. Tier names resolve through the tier config; unconfigured or
 * unavailable tiers fall back to the baseline with a warning. Throws when the
 * winner is neither a tier name nor a known model reference.
 */
function resolveChildModelRef(args: {
	pin: string | undefined;
	explicit: string | undefined;
	inherited: string | undefined;
	agentId: string;
	tiers: TierConfig;
	availableModels: readonly any[];
}): { model: string | undefined; warnings: string[] } {
	const winner = args.pin || args.explicit || undefined;
	if (winner !== undefined) {
		const winnerPart = stripThinkingSuffix(winner).model;
		if (!isTierName(winner) && !isAvailableModelRef(winnerPart, args.availableModels)) {
			throw new Error(unknownModelMessage(winnerPart, args.agentId, args.availableModels));
		}
	}
	const warnings: string[] = [];
	let model = winner || args.inherited;
	if (model) {
		if (isTierName(model) && Object.keys(args.tiers).length === 0) {
			warnings.push("model tiers unconfigured; all tiers use the session default model");
		}
		const resolution = resolveModelRef(model, args.tiers, (ref) => isAvailableModelRef(ref, args.availableModels));
		if (resolution.warning) warnings.push(resolution.warning);
		model = resolution.model;
	}
	if (model) {
		const { model: modelPart, thinking } = stripThinkingSuffix(model);
		const resolved = args.availableModels.find(
			(candidate: any) => candidate?.id === modelPart || `${candidate?.provider}/${candidate?.id}` === modelPart,
		);
		if (resolved?.provider && resolved?.id) {
			model = thinking ? `${resolved.provider}/${resolved.id}:${thinking}` : `${resolved.provider}/${resolved.id}`;
		}
	}
	return { model, warnings };
}

function wasAborted(event: any): boolean {
	if (event?.willRetry) return false;
	const messages = Array.isArray(event?.messages) ? event.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return message.stopReason === "aborted";
	}
	return false;
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

function createSessionEnvironmentFromContext(ctx: ExtensionContext, packageAgents: { user: AgentConfig[]; project: AgentConfig[] } | null): SessionEnvironment {
	const models = ctx.modelRegistry.getAvailable();
	const packageSnapshot = packageAgents
		? { user: [...packageAgents.user], project: [...packageAgents.project] }
		: null;
	return createSessionEnvironment(packageSnapshot, models);
}

/** Owns turn notifications, waits, stop markers, and per-turn status. */
class SessionTurnCoordinator {
	private readonly queue: NotificationQueue;
	private readonly stopSequences: StopSequenceManager;
	private waitState: WaitState | null = null;
	private rootRunError: string | undefined;
	private runAborted = false;
	private readonly notifiedTierIssues = new Set<string>();

	constructor(pi: ExtensionAPI) {
		this.queue = new NotificationQueue({
			steerDelivery: USE_STEER_DELIVERY,
			deliver: (combined) => {
				pi.sendMessage(
					{ customType: "subagents", content: combined, display: true },
					{ triggerTurn: true },
				);
			},
			deliverDeferred: (combined) => {
				pi.sendMessage(
					{ customType: "subagents", content: combined, display: true },
					{ deliverAs: "nextTurn" },
				);
			},
		});
		this.stopSequences = typeof (pi as any).on === "function"
			? createStopSequenceManager(pi)
			: { add() {}, remove() {}, addOnce() {}, clear() {} };
	}

	get isWaiting(): boolean {
		return this.queue.isWaiting;
	}

	queueNotification(content: string, source: "local" | "uplink"): void {
		this.queue.queue(content, source);
	}

	setParentBusy(busy: boolean, options?: { flush?: boolean }): void {
		this.queue.setParentBusy(busy, options);
	}

	trackToolStart(toolCallId: string): void {
		this.queue.trackToolStart(toolCallId);
	}

	trackToolEnd(toolCallId: string): void {
		this.queue.trackToolEnd(toolCallId);
	}

	clearPendingTools(): void {
		this.queue.clearPendingTools();
	}

	setWaiting(waiting: boolean): void {
		this.queue.setWaiting(waiting);
	}

	drainAll(): string {
		return this.queue.drainAll();
	}

	drainLocal(): string {
		return this.queue.drainLocal();
	}

	deferAll(): void {
		this.queue.deferAll();
	}

	clear(): void {
		this.queue.clear();
		this.waitState?.abortCleanup?.();
		this.waitState = null;
		this.stopSequences.clear();
	}

	addStopSequenceOnce(sequence: string): void {
		this.stopSequences.addOnce(sequence);
	}

	notifyTierIssueOnce(
		ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
		message: string,
	): void {
		if (this.notifiedTierIssues.has(message)) return;
		this.notifiedTierIssues.add(message);
		ctx.ui.notify(message, "warning");
	}

	beginRun(): void {
		this.queue.setParentBusy(true);
		this.rootRunError = undefined;
	}

	endRun(event: any): string | undefined {
		this.queue.clearPendingTools();
		this.runAborted = wasAborted(event);
		const error = terminalError(event);
		if (error) this.rootRunError = error;
		return error;
	}

	settleRun(): { aborted: boolean; rootError: string | undefined } {
		const aborted = this.runAborted;
		this.runAborted = false;
		this.queue.setParentBusy(false, { flush: !aborted });
		if (aborted) this.queue.deferAll();
		return { aborted, rootError: this.rootRunError };
	}

	resolveWait(): void {
		if (!this.waitState) return;
		const state = this.waitState;
		this.waitState = null;
		state.abortCleanup?.();
		this.queue.setWaiting(false);
		state.resolve(this.queue.drainAll());
	}

	resolveSatisfiedWait(): void {
		if (this.queue.isWaiting && this.waitState?.satisfied()) this.resolveWait();
	}

	async awaitAgentCompletion(
		ids: string[],
		manager: SubagentManager,
		signal?: AbortSignal | null,
	): Promise<string> {
		const isSatisfied = () => ids.every((id) => {
			const status = manager.getAgentStatus(id);
			return !status || isSettledState(status.state);
		});
		if (isSatisfied()) {
			const result = this.queue.drainAll();
			return result || "All specified agents have already completed. No pending notifications.";
		}
		const blocked = manager.getBlockedSenders().filter((pending) => ids.includes(pending.from));
		if (blocked.length > 0) {
			const listed = blocked
				.map((pending) => `${pending.from} (correlation_id="${pending.correlationId}")`)
				.join(", ");
			const notice =
				`Cannot wait: ${listed} ${blocked.length === 1 ? "is" : "are"} blocked on a response from you, ` +
				`so ${blocked.length === 1 ? "it" : "they"} cannot settle until you answer. ` +
				"Call respond for each pending correlation_id (the question arrived as an <agent_message>), " +
				"then call await_agents again if you still need to wait.";
			return [this.queue.drainAll(), notice].filter(Boolean).join("\n");
		}
		if (this.waitState) throw new Error("Another await_agents call is already active.");
		this.queue.setWaiting(true);
		try {
			const result = await new Promise<string>((resolve, reject) => {
				const state: WaitState = { resolve, satisfied: isSatisfied, abortCleanup: null };
				this.waitState = state;
				if (!signal) return;
				const onAbort = () => {
					this.waitState = null;
					this.queue.setWaiting(false);
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

	notifyAgentComplete(manager: SubagentManager, agentId: string, allDone: boolean): void {
		const status = manager.getAgentStatus(agentId);
		if (!status) return;
		const data: AgentCompleteData = {
			id: agentId,
			status: status.state === "errored" ? "errored" : status.state === "dead" ? "dead" : "idle",
			output: status.lastOutput,
			error: status.state === "errored" || status.state === "dead"
				? (status.lastError || "Agent run ended with an error")
				: undefined,
		};
		let xml = serializeAgentComplete(data);
		if (allDone) {
			const total = manager.getAgentStatuses().length;
			xml += `\n\nAll ${total} agent${total === 1 ? "" : "s"} have settled. Use send to ask questions or continue their work. When you're done with them, call teardown to clean up.`;
		}
		this.queue.queue(xml, "local");
		this.resolveSatisfiedWait();
	}
}

interface DashboardView {
	update(statuses: AgentStatus[]): void;
	setSessionName(name: string | undefined): void;
}

/** Owns display handles and the root-tree display subscription for one session. */
type DashboardModule = { SubagentDashboard: new (theme: unknown) => DashboardView };
type DashboardLoader = () => Promise<DashboardModule>;

export class SubagentPresentation {
	private registryUnsubscribe: (() => void) | null = null;
	private dashboard: DashboardView | null = null;
	private panelHandle: PanelHandle | null = null;
	private tuiRef: { requestRender(): void } | null = null;
	private mountingDisabled = false;
	private readonly loadDashboard: DashboardLoader;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly scope: SubagentScope,
		loadDashboard: DashboardLoader = () => import("./widget.js") as Promise<any>,
	) {
		this.loadDashboard = loadDashboard;
	}

	subscribe(registry: AgentSessionRegistry, ownerPath: AgentPath, manager: SubagentManager): void {
		if (this.registryUnsubscribe) return;
		const subscribe = (registry as any).subscribe;
		if (typeof subscribe !== "function") return;
		this.registryUnsubscribe = subscribe.call(registry, (event: RegistryEvent) => {
			const path = event.node.path;
			if (path.length <= ownerPath.length) return;
			if (!ownerPath.every((segment, index) => segment === path[index])) return;
			this.refresh(manager);
		});
	}

	async ensureWidget(ctx: ExtensionContext): Promise<void> {
		if (this.mountingDisabled || this.scope.kind === "child" || this.dashboard || this.panelHandle) return;
		if (ctx.mode === "tui") {
			const initialName = ctx.sessionManager.getSessionName?.();
			let DashboardComponent: new (theme: unknown) => DashboardView;
			try {
				({ SubagentDashboard: DashboardComponent } = await this.loadDashboard());
			} catch {
				DashboardComponent = class {
					update(_statuses: AgentStatus[]): void {}
					setSessionName(_name: string | undefined): void {}
				} as any;
			}
			if (this.mountingDisabled) return;
			ctx.ui.setWidget("subagents", (tui, theme) => {
				if (this.mountingDisabled) return undefined;
				this.tuiRef = tui;
				this.dashboard = new DashboardComponent(theme);
				this.dashboard.setSessionName(initialName);
				return this.dashboard as any;
			});
		} else {
			if (this.mountingDisabled) return;
			this.panelHandle = detect(this.pi, "subagents");
		}
	}

	preventLateMounts(): void {
		this.mountingDisabled = true;
	}

	refresh(manager: SubagentManager): void {
		if (!this.dashboard && !this.panelHandle) return;
		const statuses = manager.getDisplayStatuses();
		if (this.dashboard && this.tuiRef) {
			this.dashboard.update(statuses);
			this.tuiRef.requestRender();
		}
		if (this.panelHandle) this.panelHandle.updateCards(statusesToCards(statuses));
	}

	setSessionName(name: string | undefined): void {
		if (!this.dashboard || !this.tuiRef) return;
		this.dashboard.setSessionName(name);
		this.tuiRef.requestRender();
	}

	clear(ctx?: ExtensionContext): void {
		if (this.scope.kind === "root") ctx?.ui.setWidget("subagents", undefined as any);
		this.dashboard = null;
		this.tuiRef = null;
		if (this.panelHandle) {
			this.panelHandle.clear();
			this.panelHandle = null;
		}
	}

	shutdown(ctx?: ExtensionContext): void {
		this.preventLateMounts();
		this.registryUnsubscribe?.();
		this.registryUnsubscribe = null;
		this.clear(ctx);
	}
}

/** Owns exact reply ports and the child-session uplink subscription. */
class IncomingMessageState {
	private readonly correlationOrigin = new Map<string, MessagePort>();
	private uplinkUnsubscribe: (() => void) | null = null;
	private closed = false;

	constructor(private readonly turns: SessionTurnCoordinator) {}

	subscribeUplink(port: MessagePort): void {
		if (this.closed || this.uplinkUnsubscribe || typeof port.subscribe !== "function") return;
		this.uplinkUnsubscribe = port.subscribe((message) => this.receive(port, message, "uplink"));
	}

	receive(port: MessagePort, message: RoutedMessage, source: "local" | "uplink"): void {
		if (this.closed) return;
		if (message.responseExpected && message.correlationId && !this.rememberCorrelationOrigin(message.correlationId, port)) {
			return;
		}
		this.turns.queueNotification(serializeAgentMessage({
			from: message.from,
			content: message.message,
			correlationId: message.correlationId,
			responseExpected: message.responseExpected,
		}), source);
		if (this.turns.isWaiting) this.turns.resolveWait();
	}

	receiveSerialized(
		port: MessagePort,
		content: string,
		meta: { correlationId?: string; responseExpected: boolean },
		source: "local" | "uplink",
	): void {
		if (this.closed) return;
		if (meta.responseExpected && meta.correlationId && !this.rememberCorrelationOrigin(meta.correlationId, port)) {
			return;
		}
		this.turns.queueNotification(content, source);
		if (this.turns.isWaiting) this.turns.resolveWait();
	}

	async respond(correlationId: string, message: string): Promise<void> {
		const port = this.correlationOrigin.get(correlationId);
		if (!port) throw new Error(`No recorded response origin for correlation ID "${correlationId}".`);
		await port.respond(correlationId, message);
		this.correlationOrigin.delete(correlationId);
	}

	shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		this.uplinkUnsubscribe?.();
		this.uplinkUnsubscribe = null;
		this.correlationOrigin.clear();
	}

	private rememberCorrelationOrigin(correlationId: string, port: MessagePort): boolean {
		const existing = this.correlationOrigin.get(correlationId);
		if (existing && existing !== port) {
			this.rejectDuplicateCorrelation(port, correlationId);
			return false;
		}
		this.correlationOrigin.set(correlationId, port);
		return true;
	}

	private rejectDuplicateCorrelation(port: MessagePort, correlationId: string): void {
		const error = `Correlation ID "${correlationId}" is already pending on another recursive route`;
		if (port.reject) {
			void port.reject(correlationId, error).catch(() => {});
			return;
		}
		void port.respond(correlationId, `(no response — ${error})`).catch(() => {});
	}
}

/** Per-root or child-scope owner. Pi callbacks are adapters into this stable object. */
class SubagentSessionOwner {
	private phase: SessionPhase = { kind: "before-start" };
	private readonly turns: SessionTurnCoordinator;
	private readonly incomingMessages: IncomingMessageState;

	constructor(private readonly scope: SubagentScope, private readonly pi: ExtensionAPI) {
		this.turns = new SessionTurnCoordinator(pi);
		this.incomingMessages = new IncomingMessageState(this.turns);
	}

	register(): void {
		this.registerTools();
		this.registerCommand();
		this.registerEventHandlers();
	}

	async start(event: any, ctx: ExtensionContext): Promise<void> {
		if (this.phase.kind !== "before-start") {
			if (this.phase.kind === "starting" || this.phase.kind === "active") return;
			throw new Error("Subagents session is shutting down.");
		}
		this.phase = { kind: "starting" };
		if (this.scope.kind === "child") this.incomingMessages.subscribeUplink(this.scope.uplink);

		let packageAgents: { user: AgentConfig[]; project: AgentConfig[] } | null = null;
		try {
			packageAgents = await discoverPackageAgents(ctx.cwd);
		} catch {
			packageAgents = null;
		}
		if (this.phase.kind !== "starting") return;
		const environment = createSessionEnvironmentFromContext(ctx, packageAgents);
		const registry = this.scope.kind === "child" ? this.scope.registry : this.createRootRegistry(ctx);
		const ownerPath: AgentPath = this.scope.kind === "child" ? this.scope.path : [];
		const turns = this.turns;
		const presentation = new SubagentPresentation(this.pi, this.scope);
		const incomingMessages = this.incomingMessages;
		const manager = new SubagentManager({
			pi: this.pi,
			cwd: ctx.cwd,
			registry,
			ownerPath,
			parentSessionFile: ctx.sessionManager.getSessionFile(),
			resolveContextWindow: (modelId) => environment.resolveContextWindow(modelId),
			onUpdate: (current) => presentation.refresh(current),
			onAgentComplete: (current, agentId, allDone) => turns.notifyAgentComplete(current, agentId, allDone),
			onParentMessage: (port, content, meta) => incomingMessages.receiveSerialized(port, content, meta, "local"),
		});
		const session: ActiveSubagentSession = Object.freeze({
			environment,
			registry,
			manager,
			presentation,
			turns,
			incomingMessages,
		});
		this.phase = { kind: "active", session };
		presentation.subscribe(registry, ownerPath, manager);

		if (this.scope.kind === "child") {
			if (event.reason === "resume") {
				void this.restoreChildDescendants(ctx, session).catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`[subagents] Failed to restore nested subagents: ${message}`);
				});
			}
			return;
		}

		if (event.reason === "new" || event.reason === "fork") return;
		await manager.restoreFromPersistence(environment.discoverAgents(ctx.cwd).agents);
		if (this.phase.kind !== "active" || this.phase.session !== session || !manager.hasAgents()) return;
		await presentation.ensureWidget(ctx);
		if (this.phase.kind !== "active" || this.phase.session !== session) return;
		presentation.refresh(manager);
		turns.addStopSequenceOnce("<agent_idle");
	}

	async shutdown(ctx: ExtensionContext): Promise<void> {
		if (this.phase.kind === "shutting-down") return;
		const previous = this.phase;
		this.phase = { kind: "shutting-down" };
		if (previous.kind !== "active") {
			this.turns.clear();
			this.incomingMessages.shutdown();
			return;
		}

		const { manager, registry, turns, presentation, incomingMessages } = previous.session;
		presentation.preventLateMounts();
		turns.clear();
		incomingMessages.shutdown();
		await manager.softShutdown();
		presentation.shutdown(ctx);
		if (this.scope.kind === "root") {
			await registry.dispose();
			unregisterSessionTreeStore(ctx.sessionManager, registry.getScopedStore());
			registry.getScopedStore().clear();
		}
	}

	async handlePiEvent(eventName: string, event: any, ctx: ExtensionContext): Promise<any> {
		switch (eventName) {
			case "session_start":
				return this.start(event, ctx);
			case "session_shutdown":
				return this.shutdown(ctx);
			case "agent_start":
				return this.handleAgentStart(ctx);
			case "agent_end":
				return this.handleAgentEnd(event, ctx);
			case "agent_settled":
				return this.handleAgentSettled(ctx);
			case "message_end":
				return this.handleMessageEnd(event, ctx);
			case "session_info_changed":
				return this.handleSessionInfoChanged(event);
			case "tool_execution_start":
				return this.handleToolExecutionStart(event, ctx);
			case "tool_execution_end":
				return this.handleToolExecutionEnd(event, ctx);
			case "before_agent_start":
				return this.handleBeforeAgentStart(event, ctx);
			default:
				return undefined;
		}
	}

	private requireActiveSession(): ActiveSubagentSession {
		if (this.phase.kind === "active") return this.phase.session;
		if (this.phase.kind === "shutting-down") throw new Error("Subagents session is shutting down.");
		throw new Error("Subagents session has not started; wait for session_start before using its tools.");
	}

	private createRootRegistry(ctx: ExtensionContext): AgentSessionRegistry {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const scopedStore = getOrCreateSessionTreeStore(ctx.sessionManager);
		const registry = new AgentSessionRegistry({
			root: {
				path: [],
				parentPath: null,
				localId: null,
				ownership: "external",
				sessionId: stableRootSessionId(ctx, sessionFile),
				...(sessionFile ? { sessionFile } : {}),
				cwd: (ctx.sessionManager as { getCwd?: () => string }).getCwd?.() ?? ctx.cwd,
				channels: [],
				operational: emptyOperational("idle"),
			},
			dependencies: { agentDir: getAgentDir() },
			store: scopedStore,
		});
		registerSessionTreeStore(ctx.sessionManager, registry.getScopedStore());
		return registry;
	}

	private updateRootOperational(patch: Partial<AgentOperationalSnapshot>): void {
		if (this.scope.kind !== "root") return;
		const { registry } = this.requireActiveSession();
		const base = registry.getSnapshot([])?.operational;
		if (!base) return;
		const next: AgentOperationalSnapshot = {
			...base,
			...patch,
			usage: patch.usage ?? base.usage,
			pendingCorrelations: patch.pendingCorrelations ?? base.pendingCorrelations,
			waitingFor: patch.waitingFor ?? base.waitingFor,
		};
		registry.updateOperational([], next);
	}

	private handleAgentStart(ctx: ExtensionContext): void {
		const session = this.requireActiveSession();
		session.turns.beginRun();
		if (this.scope.kind === "root") this.updateRootOperational({ state: "running", lastError: undefined });
	}

	private handleAgentEnd(event: any, ctx: ExtensionContext): void {
		const session = this.requireActiveSession();
		const error = session.turns.endRun(event);
		if (this.scope.kind === "root" && error) this.updateRootOperational({ lastError: error });
	}

	private handleAgentSettled(ctx: ExtensionContext): void {
		const session = this.requireActiveSession();
		const { rootError } = session.turns.settleRun();
		if (this.scope.kind === "root") {
			session.registry.updateOperational([], {
				...session.registry.getSnapshot([])!.operational,
				state: rootError ? "errored" : "idle",
				lastActivity: undefined,
			});
		}
	}

	private handleMessageEnd(event: any, ctx: ExtensionContext): void {
		if (this.scope.kind !== "root" || event?.message?.role !== "assistant") return;
		const { registry } = this.requireActiveSession();
		const message = event.message;
		const usage = message.usage;
		const operational = registry.getSnapshot([])!.operational;
		const prior = operational.usage;
		const nextUsage = {
			input: prior.input + (usage?.input || 0),
			output: prior.output + (usage?.output || 0),
			cacheRead: prior.cacheRead + (usage?.cacheRead || 0),
			cacheWrite: prior.cacheWrite + (usage?.cacheWrite || 0),
			cost: prior.cost + (usage?.cost?.total || 0),
			turns: prior.turns + 1,
		};
		let lastOutput = operational.lastOutput;
		for (const part of message.content ?? []) {
			if (part.type === "text") lastOutput = part.text;
		}
		const model = message.model ?? operational.model;
		const modelInfo = ctx.modelRegistry.getAvailable().find((candidate: any) =>
			candidate?.id === model || `${candidate?.provider}/${candidate?.id}` === model,
		);
		this.updateRootOperational({
			usage: nextUsage,
			model,
			contextWindow: modelInfo?.contextWindow ?? operational.contextWindow,
			lastTurnInput: (usage?.input || 0) + (usage?.cacheRead || 0) + (usage?.cacheWrite || 0),
			lastOutput,
		});
	}

	private handleSessionInfoChanged(event: any): void {
		this.requireActiveSession().presentation.setSessionName(event.name);
	}

	private handleToolExecutionStart(event: any, ctx: ExtensionContext): void {
		const session = this.requireActiveSession();
		session.turns.trackToolStart(event.toolCallId);
		if (this.scope.kind !== "root") return;
		const raw = event as any;
		const toolName = raw.toolName ?? raw.tool?.name;
		const current = session.registry.getSnapshot([])!.operational;
		this.updateRootOperational({
			lastActivity: toolName
				? `${toolName}(${summarizeArgs(raw.args ?? raw.input ?? {})})`.replace(/[\r\n]+/g, " ")
				: current.lastActivity,
			hasSubgroup: toolName === "subagent" || toolName === "fork"
				? true
				: toolName === "teardown"
					? false
				: current.hasSubgroup,
		});
	}

	private handleToolExecutionEnd(event: any, ctx: ExtensionContext): void {
		const session = this.requireActiveSession();
		if (ctx.signal?.aborted) {
			session.turns.clearPendingTools();
			return;
		}
		session.turns.trackToolEnd(event.toolCallId);
	}

	private async handleBeforeAgentStart(event: any, ctx: ExtensionContext): Promise<{ systemPrompt: string } | undefined> {
		const session = this.requireActiveSession();
		if (!this.pi.getActiveTools().includes("subagent")) return undefined;
		const agents = session.environment.discoverAgents(ctx.cwd).agents;
		const lines = [""];
		if (agents.length > 0) {
			lines.push(
				"The following agent definitions can be referenced in the subagent tool's `agent` field.",
				"Each is self-contained — it carries its own system prompt, model, and tool restrictions. The description below is all you need to choose and deploy them; do not read their definition files before using them. Just pass the name in the `agent` field with a task string.",
				"",
				renderAgentDefinitions(agents),
				"",
			);
		}
		const availableModels: any[] = ctx.modelRegistry.getAvailable();
		const isAvailable = (ref: string) => availableModels.some((model: any) =>
			model?.id === ref || `${model?.provider}/${model?.id}` === ref,
		);
		const tiers = this.loadTiers(ctx.cwd, ctx.isProjectTrusted());
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
			"Omitting the `agent` field spawns a **default general-purpose agent** — use this unless the task specifically matches a specialist's description above. You may set `model` to override the specialist's default unless the agent definition already pins a model.",
			"",
			"Omit `model` entirely by default — subagents then inherit the session's model. Specify a tier only when the user asks for one.",
			"",
		);
		return { systemPrompt: event.systemPrompt + "\n" + lines.join("\n") + "\n" };
	}

	private loadTiers(cwd: string, projectTrusted: boolean): TierConfig {
		return loadTierConfig({
			globalPath: path.join(getAgentDir(), "model-tiers.json"),
			projectPath: path.join(cwd, ".pi", "model-tiers.json"),
			projectTrusted,
		});
	}

	private registerEventHandlers(): void {
		if (typeof (this.pi as any).on !== "function") return;
		const events = [
			"agent_start",
			"agent_end",
			"agent_settled",
			"message_end",
			"session_info_changed",
			"tool_execution_start",
			"tool_execution_end",
			"session_start",
			"before_agent_start",
			"session_shutdown",
		] as const;
		for (const eventName of events) {
			this.pi.on(eventName as any, async (event: any, ctx: ExtensionContext) => this.handlePiEvent(eventName, event, ctx));
		}
	}

	private registerCommand(): void {
		if (typeof this.pi.registerCommand !== "function") return;
		this.pi.registerCommand("fmodel", {
			description: "Force all subagents to use a specific model (/fmodel to clear)",
			getArgumentCompletions: (prefix) => this.getModelCompletions(prefix),
			handler: async (args, ctx) => this.setForcedModel(args, ctx),
		});
	}

	private getModelCompletions(prefix: string): Array<{ value: string; label: string }> | null {
		if (this.phase.kind !== "active") return null;
		const { environment } = this.phase.session;
		if (environment.cachedModels.length === 0) return null;
		const items = environment.cachedModels
			.map((model) => `${model.provider}/${model.id}`)
			.filter((ref) => !prefix || ref.startsWith(prefix) || environment.cachedModels.find((model) => model.id === ref)?.id?.startsWith(prefix));
		return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
	}

	private async setForcedModel(args: string, ctx: ExtensionContext): Promise<void> {
		this.requireActiveSession();
		const store = getOrCreateSessionTreeStore(ctx.sessionManager);
		const input = args.trim();
		if (!input) {
			const current = store.get(FORCED_MODEL_KEY);
			store.delete(FORCED_MODEL_KEY);
			ctx.ui.notify(
				current ? `Override cleared (was: ${current})` : "No override active",
				current ? "info" : "warning",
			);
			return;
		}

		const { model: modelPart, thinking } = stripThinkingSuffix(input);
		const resolved = ctx.modelRegistry.getAvailable().find(
			(model: any) => model?.id === modelPart || `${model?.provider}/${model?.id}` === modelPart,
		);
		if (!resolved) {
			ctx.ui.notify(`Unknown model "${modelPart}"`, "error");
			return;
		}

		const ref = thinking
			? `${resolved.provider}/${resolved.id}:${thinking}`
			: `${resolved.provider}/${resolved.id}`;
		store.set(FORCED_MODEL_KEY, ref);
		ctx.ui.notify(`All subagents → ${ref} (clear with /fmodel)`, "info");
	}

	private registerTools(): void {
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

		this.pi.registerTool({
			name: "list_models",
			label: "List Models",
			annotations: { readOnlyHint: true },
			description: "List all available models with context window and pricing. Complements the model-tier table for cases where a concrete model id is explicitly required.",
			promptSnippet: "Call `list_models` to see the full model catalog when a concrete model id (rather than a tier) is explicitly required.",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => this.listModels(ctx),
		});

		registerLooseTool(this.pi, {
			name: "subagent",
			label: "Subagents",
			description: "Spawn subagents to delegate work to a seperate context window, optionally with a different model or cwd. Supports inter agent communications",
			promptGuidelines: [
				"When using subagent a channel to \"parent\" (you) is auto-injected into every agent's channel list. The channels field governs peer agent communication only.",
				"Agents can be added incrementally — call subagent again to add more agents to the existing set. New agents join the running infrastructure.",
				"`subagent` defaults to non-blocking, returning immediately. The results of subagents will arrive later as notifications. If you want to block use `await=true`",
				"When using `subagent` without awaiting resist the urge to also do the same work you just delegated it is NOT your responsibility.",
				"Prefer `subagent` over `fork` when the work needs multiple coordinated agents, specialized agents, or a clean slate. Prefer `fork` when you want a copy of your current session context to explore a side quest without bloating your primary context.",
				"For `subagent` use guidance about task decomposition, pattern selection, and when-to-delegate; read the orchestrating-agents skill.",
			],
			parameters: Type.Object({
				agents: Type.Array(AgentItem, { description: "Agents to spawn under this parent session" }),
				await: Type.Optional(Type.Boolean({ description: "Block until all spawned agents complete. Default: false.", default: false })),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => this.spawnAgents(params, signal, ctx),
		});

		registerLooseTool(this.pi, {
			name: "fork",
			label: "Fork",
			description: "Clone yourself into a sub-agent with your full conversation history. Useful for existing context dependent side quests where data explored is much larger that required retained output.",
			promptGuidelines: ["`fork` generally functions exactly like `subagent` except that you keep your current session context, model and cwd without the ability to overrie them"],
			parameters: Type.Object({
				id: Type.String({ description: "Unique identifier for the forked agent" }),
				task: Type.String({ description: "Task description for the forked agent" }),
				await: Type.Optional(Type.Boolean({ description: "Block until the forked agent completes. Default: false.", default: false })),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => this.forkAgent(params, signal, ctx),
		});

		registerLooseTool(this.pi, {
			name: "send",
			label: "Send Message",
			description: "Send a mid-task clarification or coordination message to another active agent; do not use for final task reporting.",
			promptGuidelines: [
				"`send` is Fire-and-forget by default: sends the message and returns immediately. The target agent will receive it as an <agent_message> block. If you need a response use `expectResponse=true`",
				"As a subagent with a parent. You do not need to use `send` a completed-task summary to the parent. Your final text is delivered automatically.",
				"For scatter-gather: call send(expectResponse=true) to multiple agents in the same turn. Each returns when its target responds.",
			],
			parameters: Type.Object({
				to: Type.String({ description: "Target agent id or 'parent'" }),
				message: Type.String({ description: "Message content" }),
				expectResponse: Type.Optional(Type.Boolean({ description: "Wait for a response (blocking). Default: false.", default: false })),
			}),
			execute: async (_toolCallId, params, signal) => this.sendMessage(params, signal),
		});

		this.pi.registerTool({
			name: "respond",
			label: "Respond",
			description: "Responds to an agent_message with response_expected=\"true\" from another agent. Responses are mandatory when expected!",
			parameters: Type.Object({
				correlationId: Type.String({ description: "The correlation_id from the incoming agent_message" }),
				message: Type.String({ description: "Response content" }),
			}),
			execute: async (_toolCallId, params) => this.respondToMessage(params),
		});

		registerLooseTool(this.pi, {
			name: "check_status",
			label: "Check Status",
			annotations: { readOnlyHint: true },
			description: "Query agent status. Omit agent for summary of all active agents.",
			promptGuidelines: ["Use check_status only when you have a specific reason: diagnosing a suspected stall, answering a user question about progress, or checking usage mid-run."],
			parameters: Type.Object({ agent: Type.Optional(Type.String({ description: "Agent id to query. Omit for summary of all active agents." })) }),
			execute: async (_toolCallId, params) => this.checkStatus(params),
		});

		registerLooseTool(this.pi, {
			name: "teardown",
			label: "Teardown",
			description: "Remove an agent or tear down all agents. Returns a completion report.",
			promptGuidelines: ["Call teardown when an agent or all agents are no longer needed. Idle or errored (but not dead) agents remain usable — you can send new messages to restart or continue work or retry after errors."],
			parameters: Type.Object({ agent: Type.Optional(Type.String({ description: "Agent id to remove. Omit to tear down all agents." })) }),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => this.teardownAgents(params, ctx),
		});

		this.pi.registerTool({
			name: "resurrect",
			label: "Resurrect",
			description: "Bring a previously-torn-down subagent back online from its session file by using it's session_id.",
			promptGuidelines: [
				"Each resurrected agent inherits its persona, model, and tool set from the resumed session — none of those can be changed here. Only `id`, `channels`, and `task` must be re-declared.",
				"To resurrect a mesh of agents that talked to each other, resurrect them in a single call: each agent may declare channels to its siblings, since they come online together.",
			],
			parameters: Type.Object({ agents: Type.Array(ResurrectItem, { description: "Agents to resurrect from their session files." }) }),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => this.resurrectAgents(params, ctx),
		});

		registerLooseTool(this.pi, {
			name: "await_agents",
			label: "Await Agents",
			description: "Block until an agent completes or sends you a message. Returns final agent output or sent message.",
			promptGuidelines: [
				"Use `await_agents` when you need results before your next step — it blocks until all specified agents complete (or all agents, if none specified).",
				"Any agent non terminal message sent to you while you are in an await_agents tool call interrupts the wait. If an expect-response message interrupts, you must call `respond` before waiting again.",
			],
			parameters: Type.Object({ agents: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs to wait on. Omit to wait on all active agents." })) }),
			execute: async (_toolCallId, params, signal) => this.awaitAgents(params, signal),
		});

		registerLooseTool(this.pi, {
			name: "interrupt",
			label: "Interrupt",
			description: "Halt a subagent immediately without tearing it down. Interrupts any in-flight tool call — useful when one is hung or stuck.",
			promptGuidelines: ["Prefer `send` to `interrpupt` unless you realize the subagent is going wrong and must be stopped now."],
			parameters: Type.Object({ agents: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs to interrupt. Omit to interrupt all active agents." })) }),
			execute: async (_toolCallId, params, signal) => this.interruptAgents(params, signal),
		});
	}

	private listModels(ctx: ExtensionContext): any {
		this.requireActiveSession();
		const models: any[] = ctx.modelRegistry.getAvailable();
		const fmtCost = (value: unknown) => typeof value === "number" ? value.toFixed(2) : "-";
		const rows = models.map((model: any) => ({
			ref: `${model?.provider}/${model?.id}`,
			contextWindow: typeof model?.contextWindow === "number" ? String(model.contextWindow) : "-",
			input: fmtCost(model?.cost?.input),
			output: fmtCost(model?.cost?.output),
			cacheRead: fmtCost(model?.cost?.cacheRead),
		})).sort((a, b) => a.ref.localeCompare(b.ref));
		const lines = [
			"| provider/id | context window | input $/Mtok | output $/Mtok | cacheRead $/Mtok |",
			"| --- | --- | --- | --- | --- |",
			...rows.map((row) => `| ${row.ref} | ${row.contextWindow} | ${row.input} | ${row.output} | ${row.cacheRead} |`),
		];
		return { content: [{ type: "text", text: lines.join("\n") }] };
	}

	private async spawnAgents(params: any, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<any> {
		const session = this.requireActiveSession();
		const discovery = session.environment.discoverAgents(ctx.cwd);
		const allAgentConfigs = discovery.agents;
		const availableModels: any[] = ctx.modelRegistry.getAvailable();

		for (const agent of params.agents) {
			const agentName = agent.agent || undefined;
			if (agentName) {
				const foundConfig = allAgentConfigs.find((config) => config.name === agentName);
				if (!foundConfig) {
					const available = formatAgentList(allAgentConfigs, 10);
					throw new Error(`Unknown agent definition "${agentName}". Available: ${available.text}`);
				}
			}
		}

		const manager = session.manager;
		this.assertNewAgentIds(params.agents.map((agent: any) => agent.id), manager);
		const resolvedCwds = resolveAgentCwds(
			params.agents.map((agent: any) => ({ id: agent.id, cwd: agent.cwd })),
			ctx.cwd,
		);

		// One active persona file per child: the workspace declaration at the
		// effective child cwd wins wholesale over the discovered spawned
		// definition. Only the active file's declared skills resolve, and only
		// the winning model reference is validated and applied — the discarded
		// file's fields never reach construction.
		const skillPathsById = new Map<string, readonly string[]>();
		const modelById = new Map<string, string | undefined>();
		const inheritedModelRef = modelRefOf(ctx.model);
		const commands = this.pi.getCommands();
		for (const agent of params.agents) {
			const agentConfig = agent.agent
				? allAgentConfigs.find((config) => config.name === agent.agent)
				: undefined;
			const effectiveCwd = resolvedCwds.get(agent.id) ?? ctx.cwd;
			const active = loadActivePersona(effectiveCwd, agentConfig);
			const resolvedModel = resolveChildModelRef({
				pin: active?.model,
				explicit: agent.model,
				inherited: inheritedModelRef,
				agentId: agent.id,
				tiers: this.loadTiers(effectiveCwd, ctx.isProjectTrusted()),
				availableModels,
			});
			modelById.set(agent.id, resolvedModel.model);
			for (const warning of resolvedModel.warnings) session.turns.notifyTierIssueOnce(ctx, warning);
			if (!active?.skills) continue;
			try {
				skillPathsById.set(agent.id, Object.freeze(resolveSkillPaths(active.skills, commands)));
			} catch (error: any) {
				throw new Error(`Failed to resolve skills for agent "${agent.id}": ${error.message}`);
			}
		}

		const agentSpecs: RegularAgentSpec[] = params.agents.map((agent: any) => {
			const agentName = agent.agent || undefined;
			return Object.freeze({
				kind: "agent" as const,
				...agent,
				channels: agent.channels ? Object.freeze([...agent.channels]) : undefined,
				agent: agentName,
				model: modelById.get(agent.id),
				cwd: resolvedCwds.get(agent.id),
				skillPaths: skillPathsById.get(agent.id) ?? Object.freeze([]),
			});
		});

		await session.presentation.ensureWidget(ctx);
		const ack = await manager.start(agentSpecs, allAgentConfigs);
		session.presentation.refresh(manager);
		session.turns.addStopSequenceOnce("<agent_idle");
		if (params.await) {
			const ids = params.agents.map((agent: any) => agent.id);
			const waitResult = await session.turns.awaitAgentCompletion(ids, manager, signal);
			return { content: [{ type: "text", text: formatSpawnToolResult(waitResult) }] };
		}
		return { content: [{ type: "text", text: ack }] };
	}

	private async forkAgent(params: any, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<any> {
		const session = this.requireActiveSession();
		const manager = session.manager;
		if (manager.getAgentStatus(params.id)) throw new Error(`Agent id "${params.id}" already exists`);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Cannot fork: no active session file");
		const tools = [...this.pi.getActiveTools()];
		const commands = this.pi.getCommands();
		// A fork inherits the parent cwd and has no spawned definition: the
		// workspace declaration there is the only persona a fork can wear. Its
		// declared skills replace the fork snapshot list and its declared
		// model/thinking bind at the fresh bind; absent fields preserve ordinary
		// fork behavior.
		const active = loadActivePersona(ctx.cwd, undefined);
		let skillPaths: string[];
		if (active?.skills) {
			try {
				skillPaths = resolveSkillPaths(active.skills, commands);
			} catch (error: any) {
				throw new Error(`Failed to resolve skills for agent "${params.id}": ${error.message}`);
			}
		} else {
			skillPaths = commands
				.filter((command: any) => command.source === "skill" && command.path)
				.map((command: any) => command.path!);
		}
		let model: string | undefined;
		let thinkingLevel = this.pi.getThinkingLevel() as string;
		if (active?.model) {
			const resolvedModel = resolveChildModelRef({
				pin: active.model,
				explicit: undefined,
				inherited: undefined,
				agentId: params.id,
				tiers: this.loadTiers(ctx.cwd, ctx.isProjectTrusted()),
				availableModels: ctx.modelRegistry.getAvailable(),
			});
			for (const warning of resolvedModel.warnings) session.turns.notifyTierIssueOnce(ctx, warning);
			if (resolvedModel.model !== undefined) {
				model = resolvedModel.model;
				const declaredThinking = stripThinkingSuffix(resolvedModel.model).thinking;
				if (declaredThinking) thinkingLevel = declaredThinking;
			}
		}
		const forkSpec: ForkAgentSpec = {
			kind: "fork",
			id: params.id,
			task: params.task,
			sessionFile,
			tools,
			skillPaths,
			thinkingLevel,
			model,
		};
		await session.presentation.ensureWidget(ctx);
		const ack = await manager.start([forkSpec], []);
		session.presentation.refresh(manager);
		session.turns.addStopSequenceOnce("<agent_idle");
		if (params.await) {
			const result = await session.turns.awaitAgentCompletion([params.id], manager, signal);
			return { content: [{ type: "text", text: formatSpawnToolResult(result) }] };
		}
		return { content: [{ type: "text", text: ack }] };
	}

	private async sendMessage(params: any, signal: AbortSignal | undefined): Promise<any> {
		const session = this.requireActiveSession();
		if (signal?.aborted) throw new Error("Cancelled");
		const isLocalAgent = session.manager.getAgentStatus(params.to) !== undefined;
		const port = isLocalAgent
			? session.manager.getParentPort()
			: this.scope.kind === "child"
				? this.scope.uplink
				: null;
		if (!port) {
			throw new Error(
				session.manager.hasAgents()
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
		if (!correlationId || !responsePromise) throw new Error("Message route did not provide a blocking response handle");
		const source: "local" | "uplink" = this.scope.kind === "child" && port === this.scope.uplink ? "uplink" : "local";
		const deliverDeferredResponse = (response: RoutedResponse) => {
			const content = response.type === "response" ? response.message : `(no response — ${response.error})`;
			session.turns.queueNotification(serializeAgentMessage({
				from: params.to,
				content,
				correlationId,
				responseExpected: false,
			}), source);
			if (session.turns.isWaiting) session.turns.resolveWait();
		};
		type RaceResult = { kind: "response"; response: RoutedResponse } | { kind: "deferred" };
		const outcome = await new Promise<RaceResult>((resolve, reject) => {
			let settled = false;
			const detach = () => {
				if (settled) return;
				settled = true;
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
						session.turns.queueNotification(serializeAgentMessage({
							from: params.to,
							content: `(no response — ${error instanceof Error ? error.message : String(error)})`,
							correlationId,
							responseExpected: false,
						}), source);
						if (session.turns.isWaiting) session.turns.resolveWait();
						return;
					}
					settled = true;
					reject(error);
				},
			);
		});
		if (outcome.kind === "deferred") {
			return { content: [{ type: "text", text:
				`Your blocking wait on "${params.to}" was interrupted, not cancelled. "${params.to}" is still working; ` +
				`its reply will arrive later as an <agent_message> notification (correlation_id="${correlationId}"). ` +
				"Handle whatever the user needs now — you'll be prompted again when the response lands.",
			}] };
		}
		if (outcome.response.type === "response") return { content: [{ type: "text", text: outcome.response.message }] };
		throw new Error(outcome.response.error);
	}

	private async respondToMessage(params: any): Promise<any> {
		const session = this.requireActiveSession();
		await session.incomingMessages.respond(params.correlationId, params.message);
		return { content: [{ type: "text", text: "Response sent." }] };
	}

	private checkStatus(params: any): any {
		const { manager } = this.requireActiveSession();
		if (!manager.hasAgents()) throw new Error("No agents running.");
		if (params.agent) {
			const status = manager.getAgentStatus(params.agent);
			if (!status) throw new Error(`Unknown agent: "${params.agent}"`);
			return { content: [{ type: "text", text: formatAgentStatusDetail(status) }] };
		}
		return { content: [{ type: "text", text: manager.getAgentStatuses().map(formatAgentStatusSummary).join("\n") }] };
	}

	private async teardownAgents(params: any, ctx: ExtensionContext): Promise<any> {
		const session = this.requireActiveSession();
		if (!session.manager.hasAgents()) throw new Error("No agents to teardown.");
		const { report, empty } = await session.manager.teardown(params.agent || undefined);
		if (empty) {
			session.turns.drainLocal();
			session.presentation.clear(ctx);
		} else {
			session.presentation.refresh(session.manager);
		}
		const label = params.agent ? `Agent "${params.agent}" removed.` : "All agents terminated.";
		return { content: [{ type: "text", text: `${label}\n\n${report}` }] };
	}

	private async resurrectAgents(params: any, ctx: ExtensionContext): Promise<any> {
		const session = this.requireActiveSession();
		const manager = session.manager;
		if (params.agents.length === 0) throw new Error("Empty agents array — provide at least one agent to resurrect.");
		this.assertNewAgentIds(params.agents.map((agent: any) => agent.id), manager);
		const sessionIds = params.agents.map((agent: any) => agent.sessionId);
		const duplicateSessions = sessionIds.filter((id: string, index: number) => sessionIds.indexOf(id) !== index);
		if (duplicateSessions.length > 0) throw new Error(`Duplicate session ids in batch: ${[...new Set(duplicateSessions)].join(", ")}`);
		const discovery = session.environment.discoverAgents(ctx.cwd);
		const specs: RegularAgentSpec[] = [];
		for (const agent of params.agents) {
			const holder = manager.findLiveHolder(agent.sessionId);
			if (holder) throw new Error(`Session ${agent.sessionId} is currently held by live agent ${holder}; teardown that agent first or use a different one.`);
			const resolved = manager.resolveSessionFile(agent.sessionId);
			if (!resolved) {
				const parentSessionFile = ctx.sessionManager.getSessionFile();
				const childSessionsDir = parentSessionFile ? getPersistencePaths(parentSessionFile).childSessionsDir : undefined;
				if (!childSessionsDir || !fs.existsSync(childSessionsDir)) {
					throw new Error("No subagent infrastructure for this parent session — nothing to resurrect.");
				}
				throw new Error(`No session found with id ${agent.sessionId}.`);
			}
			// Capability gates re-resolve from the active persona file at the
			// opened session's persisted cwd (workspace declaration first, else
			// the persisted persona name per DR-033). Model/thinking stay as
			// persisted (DR-038): a resurrected spec carries no model override.
			const record = manager.findPersistedAgentRecord(agent.sessionId);
			const persona = record?.agent;
			const config = persona ? discovery.agents.find((candidate) => candidate.name === persona) : undefined;
			const active = loadActivePersona(record?.cwd ?? ctx.cwd, config);
			let skillPaths: readonly string[] = [];
			if (active?.skills) {
				try {
					skillPaths = Object.freeze(resolveSkillPaths(active.skills, this.pi.getCommands()));
				} catch (error: any) {
					throw new Error(`Failed to resolve skills for agent "${agent.id}": ${error.message}`);
				}
			}
			specs.push({
				kind: "agent",
				id: agent.id,
				agent: persona,
				task: agent.task,
				channels: agent.channels,
				resumeSessionFile: resolved,
				cwd: record?.cwd,
				skillPaths,
			});
		}
		await session.presentation.ensureWidget(ctx);
		const ack = await manager.start(specs, discovery.agents);
		session.presentation.refresh(manager);
		session.turns.addStopSequenceOnce("<agent_idle");
		return { content: [{ type: "text", text: ack }] };
	}

	private async awaitAgents(params: any, signal: AbortSignal | undefined): Promise<any> {
		const session = this.requireActiveSession();
		const manager = session.manager;
		if (!manager.hasAgents()) throw new Error("No agents running. Spawn agents first with the subagent or fork tool.");
		const requested = params.agents?.length ? params.agents : undefined;
		for (const id of requested ?? []) {
			if (!manager.getAgentStatus(id)) throw new Error(`Unknown agent: "${id}"`);
		}
		const ids = requested ?? manager.getAgentStatuses().map((status) => status.id);
		const result = await session.turns.awaitAgentCompletion(ids, manager, signal);
		return { content: [{ type: "text", text: result }] };
	}

	private async interruptAgents(params: any, signal: AbortSignal | undefined): Promise<any> {
		const { manager } = this.requireActiveSession();
		if (!manager.hasAgents()) throw new Error("No agents running. Spawn agents first with the subagent or fork tool.");
		const requested = params.agents?.length ? params.agents : undefined;
		for (const id of requested ?? []) {
			if (!manager.getAgentStatus(id)) throw new Error(`Unknown agent: "${id}"`);
		}
		const ids = requested ?? manager.getAgentStatuses().map((status) => status.id);
		const results = await Promise.allSettled(ids.map((id) => manager.interrupt(id, { signal })));
		const interrupted: string[] = [];
		const pending: string[] = [];
		const failed: string[] = [];
		results.forEach((result, index) => {
			if (result.status !== "fulfilled") {
				failed.push(`${ids[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
			} else if (result.value === "pending") pending.push(ids[index]);
			else interrupted.push(ids[index]);
		});
		const lines: string[] = [];
		if (interrupted.length > 0) lines.push(`Interrupted: ${interrupted.join(", ")}`);
		if (pending.length > 0) lines.push(
			`Abort delivered but not yet settled: ${pending.join(", ")}. ` +
			"Likely stuck in a tool call that ignores cancellation. Check status before relying on it, and tear it down if it stays busy.",
		);
		if (failed.length > 0) lines.push(`Failed: ${failed.join("; ")}`);
		return { content: [{ type: "text", text: lines.join("\n") || "No agents interrupted." }] };
	}

	private assertNewAgentIds(ids: string[], manager: SubagentManager): void {
		const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
		if (dupes.length > 0) throw new Error(`Duplicate agent ids: ${[...new Set(dupes)].join(", ")}`);
		const existingIds = new Set(manager.getAgentStatuses().map((status) => status.id));
		for (const id of ids) {
			if (existingIds.has(id)) throw new Error(`Agent id "${id}" already exists`);
		}
	}

	private async restoreChildDescendants(ctx: ExtensionContext, session: ActiveSubagentSession): Promise<void> {
		if (this.scope.kind !== "child") return;
		if (!await this.scope.registry.waitForLiveNode(this.scope.path)) return;
		await session.manager.restoreFromPersistence(session.environment.discoverAgents(ctx.cwd).agents);
	}
}

/** Build an extension factory bound to one root or child session scope. */
export function createSubagentsExtension(scope: SubagentScope): ExtensionFactory {
	return (pi: ExtensionAPI) => new SubagentSessionOwner(scope, pi).register();
}

function formatAgentStatusSummary(status: AgentStatus): string {
	const icon = { running: "⏳", idle: "✓", errored: "✗", dead: "⊘", waiting: "⏸" }[status.state];
	const usage = status.usage.cost > 0 ? ` ($${status.usage.cost.toFixed(4)})` : "";
	return `${icon} ${status.id}: ${status.state}${status.lastActivity ? ` — ${status.lastActivity}` : ""}${usage}`;
}

function formatAgentStatusDetail(status: AgentStatus): string {
	const lines = [
		`Agent: ${status.id}`,
		`State: ${status.state}`,
		`Channels: ${status.channels.join(", ")}`,
	];
	if (status.agentDef) lines.push(`Agent definition: ${status.agentDef}`);
	if (status.model) lines.push(`Model: ${status.model}`);
	if (status.lastActivity) lines.push(`Last activity: ${status.lastActivity}`);
	if (status.lastOutput) {
		const preview = status.lastOutput.length > 200 ? status.lastOutput.slice(0, 200) + "..." : status.lastOutput;
		lines.push(`Last output: ${preview}`);
	}
	const totalInput = status.usage.input + status.usage.cacheRead + status.usage.cacheWrite;
	lines.push(`Usage: ↑${totalInput} ↓${status.usage.output} $${status.usage.cost.toFixed(4)} (${status.usage.turns} turns)`);
	if (status.pendingCorrelations.length > 0) lines.push(`Pending correlations: ${status.pendingCorrelations.join(", ")}`);
	return lines.join("\n");
}
