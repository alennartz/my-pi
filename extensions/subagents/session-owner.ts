import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentEndEvent, BeforeAgentStartEvent, AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ExtensionFactory, Theme } from '@earendil-works/pi-coding-agent';
import { Type } from "typebox";
import type { Static } from "typebox";
import { dropEmptyOptionals, registerLooseTool } from "../../lib/tool-args.ts";
import { answerActivity } from "@pimote/sdk/activity";
import { registerProvider } from "@pimote/sdk/subagents";
import type {
	SubagentAffectedAgent,
	SubagentAgentStatus,
	SubagentDelegatedChild,
	SubagentResurrectRequest,
	SubagentResurrectResult,
	SubagentRuntimeRef,
	SubagentTeardownResult,
} from "@pimote/sdk/subagents";
import {
	getOrCreateSessionTreeStore,
	registerSessionTreeStore,
	unregisterSessionTreeStore,
} from "./scoped-store.js";
import { discoverAgents, discoverPackageAgents, resolvePersonaSkillPaths, resolveAgentCwds, formatAgentList, renderAgentDefinitions } from './agents.js';
import type { AgentConfig, RegularAgentSpec, ForkAgentSpec } from './agents.js';
import { SubagentManager, loadActivePersona, selectActivePersona } from './agent-set.js';
import type { AgentStatus, PersonaCapabilities } from './agent-set.js';
import { addCostBreakdown, costBreakdownFromUsage, AgentSessionRegistry } from './agent-session-registry.js';
import type { AgentNodeSnapshot, AgentOperationalSnapshot } from './agent-session-registry.js';
import { childAgentPath, qualifiedAgentId } from './agent-path.js';
import type { AgentPath } from './agent-path.js';
import { toolCallUpdateView, toolExecutionStartView } from './pi-events.js';
import { asRecord, booleanField, stringField } from './narrow.js';
import type { Component } from '@earendil-works/pi-tui';
import { excludeModelOnlyTools } from "./child-tool-policy.js";
import { getPersistencePaths } from "./persistence.js";
import { serializeAgentComplete, serializeAgentMessage, serializeAgentRemoved, serializeAgentResurrected } from './messages.js';
import { hasLiveBackgroundWork } from "./activity.js";
import { modelDisplayName } from "./status-display.js";
import { activityPreview } from "./format.js";
import { formatOverrideNote } from "./tool-result.js";
import { truncateForModel } from "../../lib/truncate.ts";
import { required } from "../../lib/required.ts";
import { formatUsageLine, statusData, sumAgentUsage, toPiUsage, AwaitResultSchema, InterruptResultSchema, ModelsResultSchema, ResurrectResultSchema, SendResultSchema, SpawnResultSchema, StatusResultSchema, TeardownResultSchema } from './tool-results.js';
import type { AwaitResultData, InterruptResultData, ModelsResultData, ResurrectResultData, SendResultData, SpawnResultData, StatusResultData, TeardownResultData } from './tool-results.js';
import { loadWorkspacePersona } from "../persona-workspaces/declaration.ts";
import { TIERS_UNCONFIGURED_MESSAGE, loadTierConfig, resolveDeclaredModelRef, renderTierTable, stripThinkingSuffix } from './model-tiers.js';
import type { TierConfig } from './model-tiers.js';
import type { MessagePort, RoutedMessage, RoutedResponse } from "./message-router.js";
import { SubagentControlPort } from "./control-port.js";
import type { SubagentManagerControl } from "./control-port.js";
import { createSubagentProvider } from './provider.js';
import type { OwnedSubagentProvider } from './provider.js';
import { createSubagentPresenters, messageCardDetails, toolCardDetails } from "./presenters.js";
import type { SubagentCard } from "./presenters.js";
import { RunningToolProgress } from "./tool-progress.js";
import type { SubagentTreeServices } from "./tree-services.js";
import { TurnCoordinator } from "./turn-coordinator.js";
import { settlementReceiptDetails } from "./settlement-receipts.js";
import type { Settlement } from "./settlements.js";

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
			/** Root-scoped services shared by every nested manager. */
			services: SubagentTreeServices;
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
	readonly services: SubagentTreeServices;
	readonly manager: SubagentManager;
	readonly managerControl: SubagentManagerControl;
	readonly dashboard: DashboardHost;
	readonly provider?: OwnedSubagentProvider;
	readonly unregisterProvider?: () => void;
}

type SessionPhase =
	| { kind: "before-start" }
	| { kind: "starting" }
	| { kind: "active"; session: ActiveSubagentSession }
	| { kind: "shutting-down" };

/** The result shape pi accepts from a tool handler. */
type ToolReply = AgentToolResult;

/** Publish the current card of a running tool call. */
type CardProgress = (card: SubagentCard) => void;

function createSessionEnvironment(
	packageAgents: { user: AgentConfig[]; project: AgentConfig[] } | null,
	models: readonly AvailableModel[],
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
		.flatMap((model) => model.provider && model.id ? [Object.freeze({ provider: model.provider, id: model.id })] : []));
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
	if (id) {return id;}
	if (sessionFile) {return path.basename(sessionFile, path.extname(sessionFile));}
	return ctx.sessionManager.getSessionName?.() ?? "root";
}

function summarizeArgs(args: Record<string, unknown>): string {
	if (!args) {return "";}
	if (args.command) {
		const command = String(args.command).replaceAll(/[\r\n\t]+/g, " ").replaceAll(/  +/g, " ").trim();
		return command.length > 40 ? `${command.slice(0, 40)}…` : command;
	}
	if (args.path) {return String(args.path);}
	const keys = Object.keys(args);
	return keys.length === 0 ? "" : keys.slice(0, 2).join(", ");
}


function modelRefOf(model: { provider?: unknown; id?: unknown } | undefined): string | undefined {
	if (typeof model?.id !== "string" || model.id.length === 0) {return undefined;}
	if (typeof model.provider === "string" && model.provider.length > 0) {
		return `${model.provider}/${model.id}`;
	}
	return model.id;
}

/**
 * Resolve one child construction's winning model reference.
 *
 * Precedence: the active persona's `model` pin wins outright; the explicit
 * tool `model` is gap-filling only (it applies when the active persona
 * declares no `model`); otherwise the parent-inherited baseline stands. Only
 * the winner is validated and resolved — a discarded reference is never
 * consulted. Mechanics (tier resolution, suffix split, matching, canonical
 * re-serialization) live once in `resolveDeclaredModelRef`; this wrapper only
 * owns the precedence and the child-side failure policy: the caller-supplied
 * winner is validated (throw), an inherited baseline reference is never
 * rejected (passthrough), and unconfigured/unavailable tiers fall back to the
 * baseline with a warning.
 */
type ResolvedChildModelRef = { model: string | undefined; warnings: string[] };

function resolveChildModelRef(args: {
	pin: string | undefined;
	explicit: string | undefined;
	inherited: string | undefined;
	agentId: string;
	tiers: TierConfig;
	availableModels: readonly AvailableModel[];
}): ResolvedChildModelRef {
	const winner = args.pin || args.explicit || undefined;
	const ref = winner ?? args.inherited;
	if (ref === undefined) {return { model: undefined, warnings: [] };}
	const resolved = resolveDeclaredModelRef({
		ref,
		tiers: args.tiers,
		available: args.availableModels,
		failure: winner !== undefined ? "throw" : "passthrough",
		agentId: args.agentId,
	});
	if (resolved.kind === "model") {return { model: resolved.canonical, warnings: [] };}
	if (resolved.kind === "diagnostic") {return { model: undefined, warnings: [] };}
	const warnings: string[] = [];
	if (resolved.tiersEmpty) {warnings.push(TIERS_UNCONFIGURED_MESSAGE);}
	else if (resolved.warning) {warnings.push(resolved.warning);}
	return { model: undefined, warnings };
}

/**
 * Persona name from a `subagent` call item.
 *
 * The public item-schema field is `persona`; the internal
 * `RegularAgentSpec.agent` property and the persisted lifecycle `agent` key
 * keep their historical name so old JSONL stays readable without migration.
 * The read therefore carries a compatibility fallback — `persona ?? agent` —
 * so historical call payloads and direct `tool.execute` callers (which bypass
 * schema validation and `prepareArguments`) keep working. Empty strings
 * normalize to `undefined`, matching the loose-argument "empty equals
 * omitted" contract.
 */
function personaNameOf(item: { persona?: unknown; agent?: unknown }): string | undefined {
	const name = item.persona ?? item.agent;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Map a legacy `agent` item field onto the public `persona` field before the
 * schema-driven empty-optional cleanup, so historical `subagent` payloads
 * validate against the `persona`-only schema. `persona` wins when both are
 * present; the legacy key never survives the rewrite. Pure — returns a new
 * arguments object.
 */
function renameLegacyPersonaFields(args: unknown) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {return args;}
	const items = (args as { agents?: unknown }).agents;
	if (!Array.isArray(items)) {return args;}
	return {
		...(args as Record<string, unknown>),
		agents: items.map((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {return item;}
			const { persona, agent: legacyField, ...rest } = item as Record<string, unknown>;
			const name = persona ?? legacyField;
			return name === undefined ? rest : { ...rest, persona: name };
		}),
	};
}

/** pi marks a retried run on the payload, outside its declared event type. */
function retriedRun(event: AgentEndEvent): boolean {
	return booleanField(event, "willRetry") === true;
}

function terminalError(event: AgentEndEvent): string | undefined {
	if (retriedRun(event)) {return undefined;}
	const messages = Array.isArray(event?.messages) ? event.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") {continue;}
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

type DashboardView = Component & {
	update(statuses: AgentStatus[]): void;
	setSessionName(name: string | undefined): void;
};

/** Owns display handles and the root-tree display subscription for one session. */
type DashboardModule = { SubagentDashboard: new (theme: Theme) => DashboardView };

/** Stand-in used when a mount is refused after pi requested the widget. */
class HiddenDashboard implements DashboardView {
	update(_statuses: AgentStatus[]): void {}
	setSessionName(_name: string | undefined): void {}
	render(): string[] {return [];}
	invalidate(): void {}
}
type DashboardLoader = () => Promise<DashboardModule>;

class DashboardHost {
	private registryUnsubscribe: (() => void) | null = null;
	private dashboard: DashboardView | null = null;
	private tuiRef: { requestRender(): void } | null = null;
	private mountingDisabled = false;
	private readonly loadDashboard: DashboardLoader;

	constructor(
		private readonly scope: SubagentScope,
		loadDashboard: DashboardLoader = () => import("./widget.js"),
	) {
		this.loadDashboard = loadDashboard;
	}

	subscribe(registry: AgentSessionRegistry, ownerPath: AgentPath, manager: SubagentManager): void {
		if (this.registryUnsubscribe) {return;}
		this.registryUnsubscribe = registry.subscribe((event) => {
			const path = event.node.path;
			if (path.length <= ownerPath.length) {return;}
			if (!ownerPath.every((segment, index) => segment === path[index])) {return;}
			this.refresh(manager);
		});
	}

	async ensureWidget(ctx: ExtensionContext): Promise<void> {
		if (this.mountingDisabled || this.scope.kind === "child" || this.dashboard) {return;}
		if (ctx.mode === "tui") {
			const initialName = ctx.sessionManager.getSessionName?.();
			let DashboardComponent: new (theme: Theme) => DashboardView;
			try {
				({ SubagentDashboard: DashboardComponent } = await this.loadDashboard());
			} catch (error) {
				console.error("[subagents] Dashboard failed to load:", error);
				DashboardComponent = HiddenDashboard;
			}
			if (this.mountingDisabled) {return;}
			ctx.ui.setWidget("subagents", (tui, theme) => {
				if (this.mountingDisabled) {return new HiddenDashboard();}
				this.tuiRef = tui;
				this.dashboard = new DashboardComponent(theme);
				this.dashboard.setSessionName(initialName);
				return this.dashboard;
			});
		}
	}

	preventLateMounts(): void {
		this.mountingDisabled = true;
	}

	refresh(manager: SubagentManager): void {
		if (!this.dashboard || !this.tuiRef) {return;}
		this.dashboard.update(manager.getDisplayStatuses());
		this.tuiRef.requestRender();
	}

	setSessionName(name: string | undefined): void {
		if (!this.dashboard || !this.tuiRef) {return;}
		this.dashboard.setSessionName(name);
		this.tuiRef.requestRender();
	}

	clear(ctx?: ExtensionContext): void {
		if (this.scope.kind === "root") {ctx?.ui.setWidget("subagents", undefined);}
		this.dashboard = null;
		this.tuiRef = null;
	}

	shutdown(ctx?: ExtensionContext): void {
		this.preventLateMounts();
		this.registryUnsubscribe?.();
		this.registryUnsubscribe = null;
		this.clear(ctx);
	}
}

/** Reply ports for incoming blocking messages, and the child-session uplink subscription. */
class IncomingMessages {
	private readonly origins = new Map<string, { port: MessagePort; from: AgentPath }>();
	private uplinkUnsubscribe: (() => void) | null = null;
	private closed = false;

	constructor(
		private readonly turns: TurnCoordinator,
		private readonly pathOf: (id: string, source: "local" | "uplink") => AgentPath,
	) {}

	subscribeUplink(port: MessagePort): void {
		if (this.closed || this.uplinkUnsubscribe) {return;}
		this.uplinkUnsubscribe = port.subscribe((message) => this.receive(port, message, "uplink"));
	}

	receive(port: MessagePort, message: RoutedMessage, source: "local" | "uplink"): void {
		if (this.closed) {return;}
		const from = this.pathOf(message.from, source);
		if (message.responseExpected && message.correlationId) {
			const existing = this.origins.get(message.correlationId);
			if (existing && existing.port !== port) {
				const error = `Correlation ID "${message.correlationId}" is already pending on another route`;
				void port.reject?.(message.correlationId, error).catch((error_: unknown) => console.error("[subagents] Rejecting a duplicate correlation failed:", error_));
				return;
			}
			this.origins.set(message.correlationId, { port, from });
		}
		this.turns.queueMessage(
			serializeAgentMessage({ from: message.from, content: message.message, correlationId: message.correlationId, responseExpected: message.responseExpected }),
			{
				kind: "message_received",
				state: "complete",
				data: { operation: "message_received", parameters: { from, message: message.message, expectResponse: message.responseExpected }, result: {} },
			},
		);
	}

	/** Forward the responder's reply text so far to the blocked sender. */
	responseProgress(correlationId: string, attempt: string, text: string): void {
		const origin = this.origins.get(correlationId);
		if (!origin) {return;}
		try {
			origin.port.responseProgress(correlationId, { attempt, text });
		} catch (error) {
			console.error("[subagents] Response progress failed:", error);
		}
	}

	/** Answer one request. Returns the requester's path. */
	async respond(correlationId: string, message: string): Promise<AgentPath> {
		const origin = this.origins.get(correlationId);
		if (!origin) {throw new Error(`No recorded response origin for correlation ID "${correlationId}".`);}
		await origin.port.respond(correlationId, message);
		this.origins.delete(correlationId);
		return origin.from;
	}

	shutdown(): void {
		if (this.closed) {return;}
		this.closed = true;
		this.uplinkUnsubscribe?.();
		this.uplinkUnsubscribe = null;
		this.origins.clear();
	}
}

const fmtCost = (value: number | null): string => value === null ? "-" : value.toFixed(2);

const toData = (statuses: AgentStatus[]): StatusResultData => ({ agents: statuses.map(statusData) });

function cardResult<T>(text: string, card: SubagentCard, structured: T) {
	return { content: [{ type: "text" as const, text }], details: toolCardDetails(card), structuredContent: structured };
}

function affectedAgent(snapshot: AgentNodeSnapshot, held?: Settlement) {
	return {
		path: [...snapshot.path],
		sessionId: snapshot.sessionId,
		incarnation: snapshot.incarnation,
		state: snapshot.operational.state,
		usage: snapshot.operational.usage,
		...(snapshot.task !== undefined ? { task: snapshot.task } : undefined),
		channels: [...snapshot.channels],
		...(snapshot.operational.model !== undefined ? { model: snapshot.operational.model } : undefined),
		...(held?.output !== undefined ? { output: held.output } : undefined),
		...(held?.error !== undefined ? { error: held.error } : undefined),
	} satisfies SubagentAffectedAgent;
}

function heldReport(id: string, held: readonly Settlement[]): string {
	return held.map((settlement) => `Result ${id} held back before removal:\n${serializeAgentComplete({
		id,
		status: settlement.state === "stopped" ? "idle" : settlement.state,
		output: settlement.output,
		error: settlement.error,
		sessionId: settlement.sessionId,
	})}`).join("\n\n");
}

/** Per-root or child-scope owner. Pi callbacks are adapters into this stable object. */
class SubagentSessionOwner {
	private phase: SessionPhase = { kind: "before-start" };
	private readonly turns: TurnCoordinator;
	private readonly incoming: IncomingMessages;
	private readonly startReady: Promise<void>;
	private resolveStartReady!: () => void;
	private rejectStartReady!: (error: unknown) => void;
	private startReadySettled = false;
	private nativeSessionManager: ExtensionContext["sessionManager"] | undefined;
	private nativeContext: ExtensionContext | undefined;
	private rootRunError: string | undefined;

	constructor(private readonly scope: SubagentScope, private readonly pi: ExtensionAPI) {
		this.turns = new TurnCoordinator(pi, {
			idle: () => this.nativeContext?.isIdle() ?? true,
			entries: () => this.nativeSessionManager?.getBranch() ?? [],
		});
		this.incoming = new IncomingMessages(this.turns, (id, source) => this.pathForEndpoint(id, source));
		this.startReady = new Promise<void>((resolve, reject) => {
			this.resolveStartReady = resolve;
			this.rejectStartReady = reject;
		});
		// Callers that wait for start observe the rejection; nothing else must.
		this.startReady.catch(() => undefined);
	}

	register(): void {
		this.registerTools();
		this.registerCommand();
		this.registerEventHandlers();
		// Pimote's idle reaper polls before closing an idle, clientless session
		// (DR-054). Root scope answers for the whole tree.
		if (this.scope.kind === "root" && typeof this.pi.events?.on === "function") {
			answerActivity(this.pi, () => this.isTreeActive());
		}
	}

	/** DR-054: true when closing this session now would destroy live agent work. */
	private isTreeActive(): boolean {
		const phase = this.phase;
		if (phase.kind !== "active") {return false;}
		return hasLiveBackgroundWork(phase.session.registry.listDescendants([]));
	}

	private resolveStart(): void {
		if (this.startReadySettled) {return;}
		this.startReadySettled = true;
		this.resolveStartReady();
	}

	private rejectStart(error: unknown): void {
		if (this.startReadySettled) {return;}
		this.startReadySettled = true;
		this.rejectStartReady(error);
	}

	private async waitForActiveSession(signal?: AbortSignal): Promise<ActiveSubagentSession> {
		const phase = this.phase;
		if (phase.kind === "active") {return phase.session;}
		if (phase.kind === "shutting-down") {throw new Error("Subagents session is shutting down.");}
		if (signal?.aborted) {throw new Error("Cancelled");}
		if (!signal) {
			await this.startReady;
		} else {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => reject(new Error("Cancelled"));
				signal.addEventListener("abort", onAbort, { once: true });
				this.startReady.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
			});
		}
		return this.requireActiveSession();
	}

	private requireActiveSession(): ActiveSubagentSession {
		if (this.phase.kind === "active") {return this.phase.session;}
		if (this.phase.kind === "shutting-down") {throw new Error("Subagents session is shutting down.");}
		throw new Error("Subagents session has not started; wait for session_start before using its tools.");
	}

	private async runWhenReady<T>(signal: AbortSignal | undefined, action: () => Promise<T> | T): Promise<T> {
		await this.waitForActiveSession(signal);
		return action();
	}

	/** Run a tool whose card streams through `onUpdate` and the running-progress registry. */
	private async runCardTool<T>(
		toolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback | undefined,
		action: (progress: CardProgress) => Promise<T>,
	): Promise<T> {
		const { services } = await this.waitForActiveSession(signal);
		const sessionId = this.currentSessionId();
		let open = true;
		const progress: CardProgress = (card) => {
			if (!open) {return;}
			const details = toolCardDetails(card);
			services.toolProgress.set(sessionId, toolCallId, details);
			onUpdate?.({ content: [{ type: "text", text: "" }], details });
		};
		try {
			return await action(progress);
		} finally {
			open = false;
			services.toolProgress.clear(sessionId, toolCallId);
		}
	}

	async start(event: { reason: string }, ctx: ExtensionContext): Promise<void> {
		if (this.phase.kind !== "before-start") {
			if (this.phase.kind === "starting" || this.phase.kind === "active") {return;}
			throw new Error("Subagents session is shutting down.");
		}
		this.phase = { kind: "starting" };
		this.nativeSessionManager = ctx.sessionManager;
		this.nativeContext = ctx;
		if (this.scope.kind === "child") {this.incoming.subscribeUplink(this.scope.uplink);}
		let provider: OwnedSubagentProvider | undefined;
		let unregisterProvider: (() => void) | undefined;
		try {
			let packageAgents: { user: AgentConfig[]; project: AgentConfig[] } | null = null;
			try {
				packageAgents = await discoverPackageAgents(ctx.cwd);
			} catch (error) {
				console.error("[subagents] Package agent discovery failed:", error);
			}
			if (this.phase.kind !== "starting") {return;}
			const environment = createSessionEnvironmentFromContext(ctx, packageAgents);
			let rootProvider: OwnedSubagentProvider | undefined;
			const services: SubagentTreeServices = this.scope.kind === "child"
				? this.scope.services
				: {
					control: new SubagentControlPort(),
					toolProgress: new RunningToolProgress(),
					trackRestore: (restore) => rootProvider?.trackRestore(restore),
				};
			const registry = this.scope.kind === "child" ? this.scope.registry : this.createRootRegistry(ctx, services);
			const ownerPath = this.scopePath();
			const turns = this.turns;
			const dashboard = new DashboardHost(this.scope);
			const manager = new SubagentManager({
				pi: this.pi,
				cwd: ctx.cwd,
				registry,
				ownerPath,
				parentSessionFile: ctx.sessionManager.getSessionFile(),
				resolveContextWindow: (modelId) => environment.resolveContextWindow(modelId),
				onUpdate: (current) => dashboard.refresh(current),
				onAgentStart: (_current, agentId) => turns.childStarted(agentId),
				onAgentComplete: (_current, agentId, _allDone, outcome) => turns.childSettled(agentId, outcome),
				previewDescendantAnswers: (ref) => services.control.pendingAnswers(ref),
				onAgentRemoved: (ref) => turns.childRemoved(ref),
				onAgentRestored: (ref, hold) => turns.childRestored(ref, hold),
				onSetHold: (ref, held) => turns.setHold(ref, held),
				onParentMessage: (port, _content, message) => this.incoming.receive(port, message, "local"),
			});
			turns.bind(manager, registry);
			const managerControl = manager.createControl({
				resurrect: (request) => this.resurrectThroughControl(request, ctx),
				teardown: (ref) => this.teardownThroughControl(ref),
				pendingAnswers: (ref) => turns.pendingAnswers(ref),
			});
			services.control.register(ownerPath, managerControl);
			if (this.scope.kind === "root" && this.hasProviderEventBus()) {
				provider = createSubagentProvider({
					registry,
					control: services.control,
					presenters: createSubagentPresenters({ runningToolProgress: (input) => services.toolProgress.get(input) }),
				});
				rootProvider = provider;
				unregisterProvider = registerProvider(this.pi, provider);
			}
			const session: ActiveSubagentSession = Object.freeze({
				environment,
				registry,
				services,
				manager,
				managerControl,
				dashboard,
				...(provider ? { provider } : undefined),
				...(unregisterProvider ? { unregisterProvider } : undefined),
			});
			this.phase = { kind: "active", session };
			this.resolveStart();
			dashboard.subscribe(registry, ownerPath, manager);

			if (this.scope.kind === "child") {
				if (event.reason === "resume") {await this.restoreChildDescendants(ctx, session);}
				return;
			}
			try {
				if (event.reason !== "new" && event.reason !== "fork") {
					await manager.restoreFromPersistence(environment.discoverAgents(ctx.cwd).agents);
				}
			} finally {
				provider?.markRootRestored();
			}
			if (this.phase.kind !== "active" || this.phase.session !== session || !manager.hasAgents()) {return;}
			await dashboard.ensureWidget(ctx);
			if (this.phase.kind !== "active" || this.phase.session !== session) {return;}
			dashboard.refresh(manager);
			turns.addStopSequenceOnce("<agent_idle");
		} catch (error) {
			if (this.phase.kind === "starting") {
				this.phase = { kind: "shutting-down" };
				unregisterProvider?.();
				provider?.shutdown();
				this.incoming.shutdown();
				this.rejectStart(error);
			}
			throw error;
		}
	}

	/** Shutdown finishes every step even when one fails or a tool call is still running. */
	async shutdown(ctx: ExtensionContext): Promise<void> {
		if (this.phase.kind === "shutting-down") {return;}
		const previous = this.phase;
		this.phase = { kind: "shutting-down" };
		this.rejectStart(new Error("Subagents session is shutting down."));
		this.turns.clear();
		this.incoming.shutdown();
		if (previous.kind !== "active") {return;}
		const { manager, registry, services, managerControl, dashboard, provider, unregisterProvider } = previous.session;
		services.control.unregister(this.scopePath(), managerControl);
		dashboard.preventLateMounts();
		unregisterProvider?.();
		provider?.shutdown();
		try {
			await manager.softShutdown();
		} finally {
			dashboard.shutdown(ctx);
			if (this.scope.kind === "root") {
				try {
					await registry.dispose();
				} finally {
					services.control.clear();
					unregisterSessionTreeStore(ctx.sessionManager, registry.getScopedStore());
					registry.getScopedStore().clear();
				}
			}
		}
	}

	private scopePath(): AgentPath {
		return this.scope.kind === "child" ? [...this.scope.path] : [];
	}

	private currentSessionId(): string {
		const nativeSessionId = this.nativeSessionManager?.getSessionId?.();
		if (nativeSessionId) {return nativeSessionId;}
		if (this.phase.kind === "active") {return this.phase.session.registry.getSnapshot(this.scopePath())?.sessionId ?? "";}
		return "";
	}

	/** Root-relative path of a routing endpoint seen from this scope. */
	private pathForEndpoint(id: string, source: "local" | "uplink"): AgentPath {
		const owner = source === "uplink" ? this.scopePath().slice(0, -1) : this.scopePath();
		return id === "parent" ? owner : [...owner, id];
	}

	private createRootRegistry(ctx: ExtensionContext, services: SubagentTreeServices): AgentSessionRegistry {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const scopedStore = getOrCreateSessionTreeStore(ctx.sessionManager);
		const registry = new AgentSessionRegistry({
			root: {
				path: [],
				parentPath: null,
				localId: null,
				ownership: "external",
				incarnation: "root",
				sessionId: stableRootSessionId(ctx, sessionFile),
				...(sessionFile ? { sessionFile } : undefined),
				cwd: (ctx.sessionManager as { getCwd?: () => string }).getCwd?.() ?? ctx.cwd,
				channels: [],
				operational: emptyOperational("idle"),
			},
			dependencies: { agentDir: getAgentDir() },
			services,
			store: scopedStore,
		});
		registerSessionTreeStore(ctx.sessionManager, registry.getScopedStore());
		return registry;
	}

	private updateRootOperational(patch: Partial<AgentOperationalSnapshot>): void {
		if (this.scope.kind !== "root") {return;}
		const { registry } = this.requireActiveSession();
		const base = registry.getSnapshot([])?.operational;
		if (!base) {return;}
		registry.updateOperational([], {
			...base,
			...patch,
			usage: patch.usage ?? base.usage,
			pendingCorrelations: patch.pendingCorrelations ?? base.pendingCorrelations,
			waitingFor: patch.waitingFor ?? base.waitingFor,
		});
	}

	// Pi event handlers.

	private registerEventHandlers(): void {
		const pi = this.pi;
		if (typeof pi.on !== "function") {return;}
		pi.on("session_start", (event, ctx) => {
			const started = this.start(event, ctx);
			if (this.scope.kind === "child" && event.reason === "resume") {this.scope.services.trackRestore(started);}
			void started.catch((error: unknown) => console.error("[subagents] Session start failed:", error));
		});
		pi.on("session_shutdown", async (_event, ctx) => this.shutdown(ctx));
		pi.on("agent_start", async () => {
			await this.waitForActiveSession();
			this.turns.runStarted();
			this.rootRunError = undefined;
			this.updateRootOperational({ state: "running", lastError: undefined });
		});
		pi.on("agent_end", async (event) => {
			await this.waitForActiveSession();
			const error = terminalError(event);
			if (error) {
				this.rootRunError = error;
				this.updateRootOperational({ lastError: error });
			}
		});
		pi.on("turn_end", (event) => this.handleBoundary(event.outcome));
		pi.on("agent_before_settle", (event) => this.handleBoundary(event.outcome));
		pi.on("agent_settled", async (event) => {
			await this.waitForActiveSession();
			this.turns.runSettled(event.aborted);
			this.updateRootOperational({ state: this.rootRunError ? "errored" : "idle" });
		});
		pi.on("message_update", (event) => this.handleMessageUpdate(event));
		pi.on("message_end", async (event, ctx) => this.handleMessageEnd(event.message, ctx));
		pi.on("session_info_changed", async (event) => {
			(await this.waitForActiveSession()).dashboard.setSessionName(event.name);
		});
		pi.on("tool_call", (event, ctx) => this.handleToolCall(event.toolName, ctx));
		pi.on("tool_execution_start", async (event) => this.handleToolExecutionStart(event));
		pi.on("before_agent_start", async (event, ctx) => this.handleBeforeAgentStart(event, ctx));
	}

	/** A turn boundary inside a run: queued notices join the run, which then continues to read them. */
	private handleBoundary(outcome: string): { continue: true } | undefined {
		if (this.phase.kind !== "active" || outcome === "aborted") {return undefined;}
		return this.turns.boundary() ? { continue: true } : undefined;
	}

	/** Stream a responder's reply text, read from pi-ai's parsed partial arguments. */
	private handleMessageUpdate(event: Parameters<typeof toolCallUpdateView>[0]): void {
		const update = toolCallUpdateView(event);
		if (update?.toolName !== "respond" || !update.toolCallId) {return;}
		const args = asRecord(update.args);
		const correlationId = stringField(args, "correlationId");
		const message = stringField(args, "message");
		if (correlationId && message !== undefined) {this.incoming.responseProgress(correlationId, update.toolCallId, message);}
	}

	private async handleMessageEnd(message: unknown, ctx: ExtensionContext): Promise<void> {
		const record = asRecord(message);
		if (record?.role !== "assistant") {return;}
		const content = Array.isArray(record.content) ? record.content : [];
		if (record.stopReason === "aborted" || record.stopReason === "error") {
			// A responder attempt that never ran leaves no reply. Clear its streamed text.
			for (const part of content) {
				const call = asRecord(part);
				const correlationId = stringField(asRecord(call?.arguments), "correlationId");
				const id = stringField(call, "id");
				if (call?.type === "toolCall" && call.name === "respond" && correlationId && id) {this.incoming.responseProgress(correlationId, id, "");}
			}
		}
		if (this.scope.kind !== "root") {return;}
		const { registry } = await this.waitForActiveSession();
		const usage = asRecord(record.usage);
		const operational = required(registry.getSnapshot([]), "root snapshot").operational;
		const prior = operational.usage;
		const costBreakdown = addCostBreakdown(prior.costBreakdown, costBreakdownFromUsage(usage));
		const count = (field: string): number => {
			const value = usage?.[field];
			return typeof value === "number" ? value : 0;
		};
		const cost = asRecord(usage?.cost)?.total;
		let lastOutput = operational.lastOutput;
		let lastText: string | undefined;
		for (const part of content) {
			const text = stringField(part, "text");
			if (stringField(part, "type") === "text" && text !== undefined) {
				lastOutput = text;
				lastText = text;
			}
		}
		const model = stringField(record, "model") ?? operational.model;
		const modelInfo = ctx.modelRegistry.getAvailable().find((candidate) =>
			candidate?.id === model || `${candidate?.provider}/${candidate?.id}` === model,
		);
		this.updateRootOperational({
			usage: {
				input: prior.input + count("input"),
				output: prior.output + count("output"),
				cacheRead: prior.cacheRead + count("cacheRead"),
				cacheWrite: prior.cacheWrite + count("cacheWrite"),
				cost: prior.cost + (typeof cost === "number" ? cost : 0),
				turns: prior.turns + 1,
				...(costBreakdown !== undefined ? { costBreakdown } : undefined),
			},
			model,
			contextWindow: modelInfo?.contextWindow ?? operational.contextWindow,
			lastTurnInput: count("input") + count("cacheRead") + count("cacheWrite"),
			...(lastText !== undefined ? { lastActivity: activityPreview(lastText) } : undefined),
			lastOutput,
		});
	}

	private handleToolCall(toolName: string, ctx: ExtensionContext): { block: true; reason: string } | undefined {
		if (ctx.hasUI) {return undefined;}
		const tool = this.pi.getAllTools().find((candidate) => candidate.name === toolName);
		if (tool?.exposure !== "model-only") {return undefined;}
		return { block: true, reason: "Model-only tools are unavailable in sessions without UI." };
	}

	private async handleToolExecutionStart(event: Parameters<typeof toolExecutionStartView>[0]): Promise<void> {
		const session = await this.waitForActiveSession();
		if (this.scope.kind !== "root") {return;}
		const view = toolExecutionStartView(event);
		const toolName = view.toolName;
		const current = required(session.registry.getSnapshot([]), "root snapshot").operational;
		this.updateRootOperational({
			lastActivity: toolName
				? `${toolName}(${summarizeArgs(asRecord(view.args) ?? {})})`.replaceAll(/[\r\n]+/g, " ")
				: current.lastActivity,
			hasSubgroup: toolName === "subagent" || toolName === "fork"
				? true
				: toolName === "teardown"
					? false
					: current.hasSubgroup,
		});
	}

	private async handleBeforeAgentStart(
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	): Promise<undefined> {
		const session = await this.waitForActiveSession();
		const triggerId = event.messageType === "custom" && event.message.customType === "subagents"
			? stringField(asRecord(event.message.details), "subagentNoticeId") : undefined;
		this.turns.prepareRun(triggerId);
		if (!ctx.hasUI) {
			const activeTools = this.pi.getActiveTools();
			const childTools = excludeModelOnlyTools(activeTools, this.pi.getAllTools());
			if (childTools.length !== activeTools.length) {this.pi.setActiveTools(childTools);}
		}
		if (!this.pi.getActiveTools().includes("subagent")) {return undefined;}
		const agents = session.environment.discoverAgents(ctx.cwd).agents;
		const lines = [""];
		if (agents.length > 0) {
			lines.push(
				"The following agent definitions can be referenced in the subagent tool's `persona` field.",
				"Each is self-contained — it carries its own system prompt, model, and tool restrictions. The description below is all you need to choose and deploy them; do not read their definition files before using them. Just pass the name in the `persona` field with a task string.",
				"",
				renderAgentDefinitions(agents),
				"",
			);
		}
		lines.push(
			"## Model Tiers",
			"",
			"Leave `agents[].model` unspecified by default; an omitted model inherits the current session model and thinking level.",
			"If a matching specialist is marked `invocation=\"explicit\"`, wait until the user asks for it by name before invoking it",
			"If no suitable specialist matches, omit `persona` for a default general-purpose agent.",
			"The `subagent` tool's `agents[].model` field accepts a tier name. Use the table below as optional guidance when a deliberate model choice is useful or the user requests one:",
			"",
			...renderTierTable(),
			"",
			"Raw model IDs are also accepted in `agents[].model` when the user names a specific model; `list_models` shows the full catalog.",
			"Append a thinking-effort suffix to any model id with `:<level>` (levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) — e.g. `anthropic/claude-opus-4-8:xhigh`. Tier names don't take a suffix; a tier carries whatever level its config encodes.",
			"",
			"The table is guidance for deliberate model choices, not a requirement to set `model` for every task.",
			"",
		);
		// Structured section, not a forced prompt: pi records and diffs it, and
		// it composes with every other prompt contribution in any load order.
		event.systemPromptOptions.sections["subagents"] = lines.join("\n");
		return undefined;
	}

	private loadTiers(cwd: string): TierConfig {
		return loadTierConfig({
			globalPath: path.join(getAgentDir(), "model-tiers.json"),
			projectPath: path.join(cwd, ".pi", "model-tiers.json"),
		});
	}

	private hasProviderEventBus(): boolean {
		const events = asRecord(this.pi)?.events;
		return typeof asRecord(events)?.on === "function" && typeof asRecord(events)?.emit === "function";
	}

	private registerCommand(): void {
		if (typeof this.pi.registerCommand !== "function") {return;}
		this.pi.registerCommand("fmodel", {
			description: "Force all subagents to use a specific model (/fmodel to clear)",
			getArgumentCompletions: (prefix) => this.getModelCompletions(prefix),
			handler: async (args, ctx) => this.setForcedModel(args, ctx),
		});
	}

	private getModelCompletions(prefix: string): { value: string; label: string }[] | null {
		if (this.phase.kind !== "active") {return null;}
		const { environment } = this.phase.session;
		if (environment.cachedModels.length === 0) {return null;}
		const items = environment.cachedModels
			.map((model) => `${model.provider}/${model.id}`)
			.filter((ref) => !prefix || ref.startsWith(prefix) || environment.cachedModels.find((model) => model.id === ref)?.id?.startsWith(prefix));
		return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
	}

	private async setForcedModel(args: string, ctx: ExtensionContext): Promise<void> {
		await this.waitForActiveSession(ctx.signal);
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
			(model) => model.id === modelPart || `${model.provider}/${model.id}` === modelPart,
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

	// Tools.

	private registerTools(): void {
		this.pi.registerTool({
			name: "list_models",
			label: "List Models",
			exposure: "direct",
			annotations: { readOnlyHint: true },
			outputSchema: ModelsResultSchema,
			description: "Return each available model ref with its context window, and its input, output, and cache-read cost per million tokens.",
			promptSnippet: "Full catalog of available models with context window and pricing.",
			promptGuidelines: ["Use list_models only when a concrete model id is required. Otherwise use the tier table."],
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => this.runWhenReady(signal, () => this.listModels(ctx)),
		});

		this.pi.registerTool({
			name: "subagent",
			label: "Subagents",
			exposure: "direct",
			outputSchema: SpawnResultSchema,
			description: "Spawn child agents that run in separate context windows. Children inherit the parent model and cwd unless an agent sets them. Results arrive later as notifications; use await_agents to wait.",
			promptSnippet: "Delegate work to child agents with separate context windows.",
			promptGuidelines: [
				"Before calling subagent, confirm a concrete delegation case: context relief from a long investigation, two or more independent deliverables, a distinct specialist or tool scope, or an explicit user request, and complete short, single-threaded work directly when no case applies.",
				"Leave model unset unless the task or the user needs a specific model.",
				"Call subagent again to add agents to a running set. New agents join the running infrastructure.",
				"After a subagent call, do not repeat the delegated work. Use await_agents when completion is required.",
				"Prefer `subagent` over `fork` when the work needs multiple coordinated agents, specialized agents, or a clean slate. Prefer `fork` when you want a copy of your current session context to explore a side quest without bloating your primary context.",
				"Read the orchestrating-agents skill before splitting work across subagents.",
			],
			parameters: SubagentParamsSchema,
			executionMode: "sequential",
			// Legacy `agent` item fields rewrite to the public `persona` field
			// first, so the empty-optional cleanup and schema validation see only
			// the advertised name.
			prepareArguments: (args: unknown) => dropEmptyOptionals(SubagentParamsSchema, renameLegacyPersonaFields(args)) as SubagentToolParams,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => this.runCardTool(toolCallId, signal, onUpdate, (progress) => this.spawnAgents(params, ctx, progress)),
		});

		registerLooseTool(this.pi, {
			name: "fork",
			label: "Fork",
			exposure: "direct",
			outputSchema: SpawnResultSchema,
			description: "Start a child agent from a copy of this conversation. The child inherits the model and cwd. Returns the same result shape as subagent.",
			promptSnippet: "Fork a child agent that keeps your full conversation history.",
			parameters: ForkParamsSchema,
			executionMode: "sequential",
			execute: async (toolCallId, params, signal, onUpdate, ctx) => this.runCardTool(toolCallId, signal, onUpdate, (progress) => this.forkAgent(params, ctx, progress)),
		});

		registerLooseTool(this.pi, {
			name: "send",
			label: "Send Message",
			exposure: "direct",
			outputSchema: SendResultSchema,
			description: "Deliver a message to a named agent or to parent. When expectResponse is true, the call blocks until the target replies.",
			promptSnippet: "Send a mid-task message to another active agent; fire-and-forget by default, use expectResponse=true to block for a response.",
			promptGuidelines: [
				"As a subagent, do not use send to report a final result. Your final text reaches the parent automatically.",
				"For scatter-gather: call send(expectResponse=true) to multiple agents in the same turn. Each returns when its target responds.",
			],
			parameters: SendParamsSchema,
			execute: async (toolCallId, params, signal, onUpdate) => this.runCardTool(toolCallId, signal, onUpdate, (progress) => this.sendMessage(params, signal, progress)),
		});

		this.pi.registerTool({
			name: "respond",
			label: "Respond",
			exposure: "direct",
			description: "Reply to one agent_message by correlationId. Required when response_expected is true.",
			promptSnippet: "Answer an agent_message that needs a reply.",
			parameters: RespondParamsSchema,
			execute: async (_toolCallId, params, signal) => this.runWhenReady(signal, () => this.respondToMessage(params)),
		});

		registerLooseTool(this.pi, {
			name: "check_status",
			label: "Check Status",
			exposure: "direct",
			annotations: { readOnlyHint: true },
			outputSchema: StatusResultSchema,
			description: "Query agent status. Omit agent for summary of all active agents.",
			promptSnippet: "Query agent status; use only for a specific reason: suspected stall, progress question, or mid-run usage check.",
			parameters: CheckStatusParamsSchema,
			execute: async (_toolCallId, params, signal) => this.runWhenReady(signal, () => this.checkStatus(params)),
		});

		registerLooseTool(this.pi, {
			name: "teardown",
			label: "Teardown",
			exposure: "direct",
			outputSchema: TeardownResultSchema,
			description: "Remove an agent or tear down all agents. Returns a completion report.",
			promptSnippet: "Remove agents no longer needed; idle or errored agents stay usable, so send new messages to restart or continue work.",
			parameters: TeardownParamsSchema,
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => this.runWhenReady(signal, () => this.teardownAgents(params, ctx)),
		});

		this.pi.registerTool({
			name: "resurrect",
			label: "Resurrect",
			exposure: "direct",
			outputSchema: ResurrectResultSchema,
			description: "Revive a torn-down subagent from its session file. Persona and tools are inherited and fixed. Model precedence matches spawning: a persona model pin wins, then an explicit model, then the model the session last ran on. Re-declare id, channels, and task.",
			promptSnippet: "Revive a torn-down agent from its session_id.",
			promptGuidelines: [
				"To resurrect a mesh of agents that talked to each other, resurrect them in a single call: each agent may declare channels to its siblings, since they come online together.",
			],
			parameters: ResurrectParamsSchema,
			executionMode: "sequential",
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => this.runWhenReady(signal, () => this.resurrectAgents(params, ctx, "model")),
		});

		registerLooseTool(this.pi, {
			name: "await_agents",
			label: "Await Agents",
			exposure: "direct",
			outputSchema: AwaitResultSchema,
			description: "Returns the final output of a completed agent, or the first message sent to you. Use agents to narrow the wait.",
			promptSnippet: "Wait for named agents to finish or send a message. Omit agents to wait on all.",
			promptGuidelines: [
				"Any agent message that arrives during await_agents interrupts the wait. If that message expects a response, you must call `respond` before waiting again.",
			],
			parameters: AwaitParamsSchema,
			execute: async (toolCallId, params, signal, onUpdate) => this.runCardTool(toolCallId, signal, onUpdate, (progress) => this.awaitAgents(params, signal, progress)),
		});

		registerLooseTool(this.pi, {
			name: "interrupt",
			label: "Interrupt",
			exposure: "direct",
			outputSchema: InterruptResultSchema,
			description: "Halt a subagent immediately without tearing it down. Interrupts any in-flight tool call. Returns interrupted, pending, and failed agent lists. pending means the abort was delivered but has not settled.",
			promptSnippet: "Halt an agent immediately without tearing it down; prefer send unless the agent must stop now.",
			parameters: InterruptParamsSchema,
			execute: async (_toolCallId, params, signal) => this.runWhenReady(signal, () => this.interruptAgents(params, signal)),
		});
	}

	private listModels(ctx: ExtensionContext): AgentToolResult<ModelsResultData> & { structuredContent: ModelsResultData } {
		this.requireActiveSession();
		const models = ctx.modelRegistry.getAvailable();
		const data: ModelsResultData = {
			models: models.map((model) => ({
				ref: `${model?.provider}/${model?.id}`,
				contextWindow: typeof model?.contextWindow === "number" ? model.contextWindow : null,
				inputCostPerMtok: typeof model?.cost?.input === "number" ? model.cost.input : null,
				outputCostPerMtok: typeof model?.cost?.output === "number" ? model.cost.output : null,
				cacheReadCostPerMtok: typeof model?.cost?.cacheRead === "number" ? model.cost.cacheRead : null,
			})).sort((a, b) => a.ref.localeCompare(b.ref)),
		};
		const lines = [
			"| provider/id | context window | input $/Mtok | output $/Mtok | cacheRead $/Mtok |",
			"| --- | --- | --- | --- | --- |",
			...data.models.map((row) =>
				`| ${row.ref} | ${row.contextWindow ?? "-"} | ${fmtCost(row.inputCostPerMtok)} | ${fmtCost(row.outputCostPerMtok)} | ${fmtCost(row.cacheReadCostPerMtok)} |`),
		];
		return { content: [{ type: "text", text: lines.join("\n") }], details: data, structuredContent: data };
	}

	private delegationCard(
		state: SubagentCard["state"],
		parameters: Extract<SubagentCard["data"], { operation: "delegation" }>["parameters"],
		children: readonly SubagentDelegatedChild[],
	): SubagentCard {
		return { kind: "delegation", state, data: { operation: "delegation", parameters, result: { children } } };
	}

	private delegatedChildren(manager: SubagentManager, items: readonly { id: string; task: string; persona?: string }[]): SubagentDelegatedChild[] {
		return items.map((item) => ({
			path: childAgentPath(this.scopePath(), item.id),
			task: item.task,
			...(item.persona !== undefined ? { persona: item.persona } : undefined),
			status: manager.getAgentStatus(item.id)?.state ?? "running",
		}));
	}

	private async spawnAgents(params: SubagentToolParams, ctx: ExtensionContext, progress: CardProgress): Promise<ToolReply> {
		const session = this.requireActiveSession();
		const discovery = session.environment.discoverAgents(ctx.cwd);
		const allAgentConfigs = discovery.agents;
		const availableModels = ctx.modelRegistry.getAvailable();
		const parameters = {
			agents: params.agents.map((agent) => ({
				id: agent.id,
				task: agent.task,
				...(personaNameOf(agent) !== undefined ? { persona: personaNameOf(agent) } : undefined),
				...(agent.model !== undefined ? { model: agent.model } : undefined),
				...(agent.cwd !== undefined ? { cwd: agent.cwd } : undefined),
				...(agent.channels !== undefined ? { channels: [...agent.channels] } : undefined),
			})),
			fork: false,
		};

		for (const agent of params.agents) {
			const agentName = personaNameOf(agent);
			if (agentName && !allAgentConfigs.some((config) => config.name === agentName)) {
				const available = formatAgentList(allAgentConfigs, 10);
				throw new Error(`Unknown persona "${agentName}". Available agent definitions: ${available.text}`);
			}
		}

		const manager = session.manager;
		const resolvedCwds = resolveAgentCwds(
			params.agents.map((agent) => ({ id: agent.id, cwd: agent.cwd })),
			ctx.cwd,
		);

		// One active persona file per child: the workspace declaration at the
		// effective child cwd wins wholesale over the discovered spawned
		// definition. The file is read exactly once per child here; its resolved
		// capabilities ride the spec, so construction never re-reads it. Only the
		// winning model reference is validated and applied. An unpinned child
		// also inherits this session's thinking level.
		const activeById = new Map<string, PersonaCapabilities | undefined>();
		const skillPathsById = new Map<string, readonly string[]>();
		const modelById = new Map<string, string | undefined>();
		const thinkingLevelById = new Map<string, string | undefined>();
		const inheritedModelRef = modelRefOf(ctx.model);
		const inheritedThinkingLevel = this.pi.getThinkingLevel() as string;
		const overrideNotes: string[] = [];
		const commands = this.pi.getCommands();
		for (const agent of params.agents) {
			const agentName = personaNameOf(agent);
			const agentConfig = agentName ? allAgentConfigs.find((config) => config.name === agentName) : undefined;
			const effectiveCwd = resolvedCwds.get(agent.id) ?? ctx.cwd;
			const workspace = loadWorkspacePersona(effectiveCwd);
			const active = selectActivePersona(workspace, agentConfig);
			activeById.set(agent.id, active);
			// A requested persona that lost wholesale to the workspace is
			// surfaced to the orchestrator in the tool result.
			if (agentName && workspace) {overrideNotes.push(formatOverrideNote(agentName, workspace.name, effectiveCwd));}
			const resolvedModel = resolveChildModelRef({
				pin: active?.model,
				explicit: agent.model,
				inherited: inheritedModelRef,
				agentId: agent.id,
				tiers: this.loadTiers(effectiveCwd),
				availableModels,
			});
			modelById.set(agent.id, resolvedModel.model);
			thinkingLevelById.set(agent.id, !active?.model && !agent.model ? inheritedThinkingLevel : undefined);
			for (const warning of resolvedModel.warnings) {this.turns.notifyTierIssueOnce(ctx, warning);}
			if (!active?.skills) {continue;}
			try {
				skillPathsById.set(agent.id, Object.freeze(resolvePersonaSkillPaths(active.skills, commands, "fatal").skillPaths));
			} catch (error: unknown) {
				throw new Error(`Failed to resolve skills for agent "${agent.id}": ${stringField(error, "message") ?? String(error)}`, { cause: error });
			}
		}

		const agentSpecs: RegularAgentSpec[] = params.agents.map((agent) => {
			// The public `persona` item field maps onto the internal `agent` spec
			// property; neither may ride the spread as a stray property.
			const { persona: _personaField, ...item } = agent;
			const active = activeById.get(agent.id);
			return Object.freeze({
				kind: "agent" as const,
				...item,
				channels: agent.channels ? Object.freeze([...agent.channels]) : undefined,
				agent: personaNameOf(agent),
				personaName: active?.name,
				personaIcon: active?.icon,
				model: modelById.get(agent.id),
				thinkingLevel: thinkingLevelById.get(agent.id),
				cwd: resolvedCwds.get(agent.id),
				skillPaths: skillPathsById.get(agent.id) ?? Object.freeze([]),
				noSkills: active?.skills ? true : undefined,
				personaTools: active?.tools,
			});
		});
		const children = agentSpecs.map((spec) => ({ id: spec.id, task: spec.task, ...(spec.personaName !== undefined ? { persona: spec.personaName } : undefined) }));

		progress(this.delegationCard("active", parameters, this.delegatedChildren(manager, children)));
		await session.dashboard.ensureWidget(ctx);
		const ack = await manager.start(agentSpecs, allAgentConfigs);
		session.dashboard.refresh(manager);
		this.turns.addStopSequenceOnce("<agent_idle");
		const overrideNote = overrideNotes.length > 0 ? `\n\n${overrideNotes.join("\n")}` : "";
		const data: SpawnResultData = {
			agents: params.agents.map((agent) => ({ id: agent.id, status: manager.getAgentStatus(agent.id)?.state ?? "running" })),
		};
		return cardResult(ack + overrideNote, this.delegationCard("complete", parameters, this.delegatedChildren(manager, children)), data);
	}

	private async forkAgent(params: ForkToolParams, ctx: ExtensionContext, progress: CardProgress): Promise<ToolReply> {
		const session = this.requireActiveSession();
		const manager = session.manager;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {throw new Error("Cannot fork: no active session file");}
		const parameters = { agents: [{ id: params.id, task: params.task }], fork: true };
		const tools = [...this.pi.getActiveTools()];
		const commands = this.pi.getCommands();
		// A fork inherits the parent cwd and has no spawned definition: the
		// workspace declaration there is the only persona a fork can wear.
		const active = loadActivePersona(ctx.cwd, undefined);
		let skillPaths: string[];
		if (active?.skills) {
			try {
				skillPaths = resolvePersonaSkillPaths(active.skills, commands, "fatal").skillPaths;
			} catch (error: unknown) {
				throw new Error(`Failed to resolve skills for agent "${params.id}": ${stringField(error, "message") ?? String(error)}`, { cause: error });
			}
		} else {
			skillPaths = commands
				.filter((command) => command.source === "skill")
				.map((command) => command.sourceInfo.path);
		}
		let model: string | undefined;
		let thinkingLevel = this.pi.getThinkingLevel() as string;
		if (active?.model) {
			const resolvedModel = resolveChildModelRef({
				pin: active.model,
				explicit: undefined,
				inherited: undefined,
				agentId: params.id,
				tiers: this.loadTiers(ctx.cwd),
				availableModels: ctx.modelRegistry.getAvailable(),
			});
			for (const warning of resolvedModel.warnings) {this.turns.notifyTierIssueOnce(ctx, warning);}
			if (resolvedModel.model !== undefined) {
				model = resolvedModel.model;
				const declaredThinking = stripThinkingSuffix(resolvedModel.model).thinking;
				if (declaredThinking) {thinkingLevel = declaredThinking;}
			}
		}
		const forkSpec: ForkAgentSpec = {
			kind: "fork",
			id: params.id,
			personaName: active?.name,
			personaIcon: active?.icon,
			task: params.task,
			sessionFile,
			tools,
			skillPaths,
			noSkills: active?.skills ? true : undefined,
			personaTools: active?.tools,
			thinkingLevel,
			model,
		};
		const children = [{ id: params.id, task: params.task, ...(active?.name !== undefined ? { persona: active.name } : undefined) }];
		progress(this.delegationCard("active", parameters, this.delegatedChildren(manager, children)));
		await session.dashboard.ensureWidget(ctx);
		const ack = await manager.start([forkSpec], []);
		session.dashboard.refresh(manager);
		this.turns.addStopSequenceOnce("<agent_idle");
		const data: SpawnResultData = { agents: [{ id: params.id, status: manager.getAgentStatus(params.id)?.state ?? "running" }] };
		return cardResult(ack, this.delegationCard("complete", parameters, this.delegatedChildren(manager, children)), data);
	}

	private async sendMessage(params: SendToolParams, signal: AbortSignal | undefined, progress: CardProgress): Promise<ToolReply> {
		const session = this.requireActiveSession();
		if (signal?.aborted) {throw new Error("Cancelled");}
		const isLocalAgent = session.manager.getAgentStatus(params.to) !== undefined;
		const port = isLocalAgent
			? session.manager.getParentPort()
			: this.scope.kind === "child" ? this.scope.uplink : null;
		if (!port) {
			throw new Error(session.manager.hasAgents()
				? `No route to agent "${params.to}".`
				: "No agents running. Spawn agents first with the subagent or fork tool.");
		}
		const source = isLocalAgent ? "local" : "uplink";
		const target = this.pathForEndpoint(params.to, source);
		const parameters = { to: params.to, target, message: params.message, expectResponse: params.expectResponse === true };
		const card = (state: SubagentCard["state"], result: Extract<SubagentCard["data"], { operation: "send" }>["result"]): SubagentCard =>
			({ kind: "send", state, data: { operation: "send", parameters, result } });
		progress(card("active", { phase: "sending" }));
		let waiting = false;
		const receipt = await port.send({
			to: params.to,
			message: params.message,
			expectResponse: params.expectResponse ?? false,
			onProgress: ({ text }) => {
				if (!waiting) {return;}
				progress(card("active", text.length > 0 ? { phase: "responding", response: text } : { phase: "waiting" }));
			},
		});
		if (!params.expectResponse) {
			const data: SendResultData = { response: null, deferred: false };
			return cardResult(`Message sent to ${params.to}.`, card("complete", { phase: "complete" }), data);
		}
		const correlationId = receipt.correlationId;
		const responsePromise = receipt.response;
		if (!correlationId || !responsePromise) {throw new Error("Message route did not provide a blocking response handle");}
		waiting = true;
		progress(card("active", { phase: "waiting" }));
		const deliverLate = (response: RoutedResponse): void => {
			if (this.phase.kind !== "active") {return;}
			const content = response.type === "response" ? response.message : `(no response — ${response.error})`;
			this.turns.queueMessage(
				serializeAgentMessage({ from: params.to, content, correlationId, responseExpected: false }),
				response.type === "response"
					? { kind: "message_received", state: "complete", data: { operation: "message_received", parameters: { from: target, message: response.message, expectResponse: false }, result: {} } }
					: card("error", { phase: "complete", error: response.error }),
			);
		};
		type Outcome = { kind: "response"; response: RoutedResponse } | { kind: "deferred" };
		const outcome = await new Promise<Outcome>((resolve, reject) => {
			let settled = false;
			const onAbort = () => {
				if (settled) {return;}
				settled = true;
				waiting = false;
				port.detach(correlationId);
				resolve({ kind: "deferred" });
			};
			if (signal?.aborted) {onAbort();}
			else {signal?.addEventListener("abort", onAbort, { once: true });}
			responsePromise.then(
				(response) => {
					signal?.removeEventListener("abort", onAbort);
					if (settled) {
						deliverLate(response);
						return;
					}
					settled = true;
					resolve({ kind: "response", response });
				},
				(error: unknown) => {
					signal?.removeEventListener("abort", onAbort);
					const failure: RoutedResponse = { type: "error", error: error instanceof Error ? error.message : String(error) };
					if (settled) {
						deliverLate(failure);
						return;
					}
					settled = true;
					reject(error);
				},
			);
		});
		waiting = false;
		if (outcome.kind === "deferred") {
			const data: SendResultData = { response: null, deferred: true, correlationId };
			return cardResult(
				`Your blocking wait on "${params.to}" was interrupted, not cancelled. "${params.to}" is still working; ` +
				`its reply will arrive later as an <agent_message> notification (correlation_id="${correlationId}"). ` +
				"Handle whatever the user needs now — you'll be prompted again when the response lands.",
				card("aborted", { phase: "complete" }),
				data,
			);
		}
		if (outcome.response.type === "error") {throw new Error(outcome.response.error);}
		const bounded = await truncateForModel(outcome.response.message);
		const data: SendResultData = { response: outcome.response.message, deferred: false, correlationId };
		return cardResult(bounded.text, card("complete", { phase: "complete", response: outcome.response.message }), data);
	}

	private async respondToMessage(params: RespondToolParams): Promise<ToolReply> {
		this.requireActiveSession();
		const to = await this.incoming.respond(params.correlationId, params.message);
		const card: SubagentCard = { kind: "respond", state: "complete", data: { operation: "respond", parameters: { to, message: params.message }, result: {} } };
		return { content: [{ type: "text", text: "Response sent." }], details: toolCardDetails(card) };
	}

	private checkStatus(params: CheckStatusToolParams): AgentToolResult<StatusResultData> & { structuredContent: StatusResultData } {
		const { manager } = this.requireActiveSession();
		if (!manager.hasAgents()) {throw new Error("No agents running.");}
		if (params.agent) {
			const status = manager.getAgentStatus(params.agent);
			if (!status) {throw new Error(`Unknown agent: "${params.agent}"`);}
			const data = toData([status]);
			return { content: [{ type: "text", text: formatAgentStatusDetail(status) }], details: data, structuredContent: data };
		}
		const statuses = manager.getAgentStatuses();
		const data = toData(statuses);
		return { content: [{ type: "text", text: statuses.map(formatAgentStatusSummary).join("\n") }], details: data, structuredContent: data };
	}

	private async teardownAgents(params: TeardownToolParams, ctx: ExtensionContext): Promise<ToolReply> {
		const session = this.requireActiveSession();
		const { text, nodes, agents, empty } = await session.manager.teardown(params.agent || undefined);
		if (empty) {session.dashboard.clear(ctx);}
		else {session.dashboard.refresh(session.manager);}
		const affectedAgents = nodes.map(({ snapshot, answers }) => affectedAgent(snapshot, answers.at(-1)));
		const heldText = nodes.filter(({ answers }) => answers.length > 0)
			.map(({ snapshot, answers }) => heldReport(qualifiedAgentId(this.scopePath(), snapshot.path), answers));
		const label = params.agent ? `Agent "${params.agent}" removed.` : "All agents terminated.";
		const single = agents.length === 1 ? agents[0] : undefined;
		const usageLine = single ? `\n\n${formatUsageLine(single.usage, single.usageBaseline)}` : "";
		const bounded = await truncateForModel([`${label}\n\n${text}${usageLine}`, ...heldText].join("\n\n"));
		const data: TeardownResultData = { agents, affectedAgents };
		const card: SubagentCard = {
			kind: "teardown",
			state: "complete",
			data: { operation: "teardown", parameters: { ...(params.agent ? { agent: params.agent } : undefined), source: "model" }, result: { affectedAgents } },
		};
		// `usage` is pi's ToolResultMessage accounting seam. `details` does not
		// contribute to the root session total.
		const usage = toPiUsage(sumAgentUsage(agents.map((agent) => agent.usage)));
		return { ...cardResult(bounded.text, card, data), usage };
	}

	/** User resurrection: the parent learns of it as context, without a turn. */
	private async resurrectThroughControl(request: SubagentResurrectRequest, ctx: ExtensionContext): Promise<SubagentResurrectResult> {
		const session = this.requireActiveSession();
		const params: ResurrectToolParams = {
			agents: [{
				id: request.localId,
				sessionId: request.sessionId,
				task: request.task,
				channels: [...request.channels],
				...(request.model !== undefined ? { model: request.model } : undefined),
			}],
		};
		const result = await this.resurrectAgents(params, ctx, "user");
		const pathValue = childAgentPath(this.scopePath(), request.localId);
		const snapshot = session.registry.getSnapshot(pathValue);
		this.pi.sendMessage(
			{
				customType: "subagents",
				content: serializeAgentResurrected({ id: request.localId, sessionId: snapshot?.sessionId, task: request.task, model: request.model }),
				display: true,
				details: messageCardDetails([result.card]),
			},
			{ triggerTurn: false },
		);
		return { path: pathValue, sessionId: snapshot?.sessionId, incarnation: snapshot?.incarnation };
	}

	/** User teardown: the parent learns of it as context, without a turn. */
	private async teardownThroughControl(ref: SubagentRuntimeRef): Promise<SubagentTeardownResult> {
		const session = this.requireActiveSession();
		const { result, report } = await session.manager.teardownGuarded(ref);
		if (!report) {return result;}
		const localId = required(ref.path.at(-1), "child local id");
		const affectedAgents = report.nodes.map(({ snapshot, answers }) => affectedAgent(snapshot, answers.at(-1)));
		const heldText = report.nodes.filter(({ answers }) => answers.length > 0)
			.map(({ snapshot, answers }) => heldReport(qualifiedAgentId(this.scopePath(), snapshot.path), answers));
		const card: SubagentCard = {
			kind: "teardown",
			state: "complete",
			data: { operation: "teardown", parameters: { agent: localId, source: "user" }, result: { affectedAgents } },
		};
		this.pi.sendMessage(
			{
				customType: "subagents",
				content: [serializeAgentRemoved({ id: localId, sessionId: result.sessionId }), ...heldText].join("\n\n"),
				display: true,
				details: messageCardDetails([card]),
			},
			{ triggerTurn: false },
		);
		session.dashboard.refresh(session.manager);
		return result;
	}

	private async resurrectAgents(params: ResurrectToolParams, ctx: ExtensionContext, source: "model" | "user"): Promise<ToolReply & { card: SubagentCard }> {
		const session = this.requireActiveSession();
		const manager = session.manager;
		if (params.agents.length === 0) {throw new Error("Empty agents array — provide at least one agent to resurrect.");}
		const discovery = session.environment.discoverAgents(ctx.cwd);
		const specs: RegularAgentSpec[] = [];
		for (const agent of params.agents) {
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
			// the persisted persona name per DR-033). The model follows spawn
			// precedence (DR-061).
			const record = manager.findPersistedAgentRecord(agent.sessionId);
			const requestedPersona = record?.agent;
			const persistedWinner = record?.personaName ?? requestedPersona;
			const config = persistedWinner ? discovery.agents.find((candidate) => candidate.name === persistedWinner) : undefined;
			const active = loadActivePersona(record?.cwd ?? ctx.cwd, config);
			const resolvedModel = resolveChildModelRef({
				pin: active?.model,
				explicit: agent.model,
				inherited: undefined,
				agentId: agent.id,
				tiers: this.loadTiers(record?.cwd ?? ctx.cwd),
				availableModels: ctx.modelRegistry.getAvailable(),
			});
			for (const warning of resolvedModel.warnings) {this.turns.notifyTierIssueOnce(ctx, warning);}
			let skillPaths: readonly string[] = [];
			if (active?.skills) {
				try {
					skillPaths = Object.freeze(resolvePersonaSkillPaths(active.skills, this.pi.getCommands(), "fatal").skillPaths);
				} catch (error: unknown) {
					throw new Error(`Failed to resolve skills for agent "${agent.id}": ${stringField(error, "message") ?? String(error)}`, { cause: error });
				}
			}
			specs.push({
				kind: "agent",
				id: agent.id,
				agent: requestedPersona,
				personaName: active?.name ?? record?.personaName,
				personaIcon: active?.icon ?? record?.personaIcon,
				task: agent.task,
				channels: agent.channels,
				resumeSessionFile: resolved,
				model: resolvedModel.model,
				cwd: record?.cwd,
				skillPaths,
				noSkills: active?.skills ? true : undefined,
				personaTools: active?.tools,
			});
		}
		await session.dashboard.ensureWidget(ctx);
		const ack = await manager.start(specs, discovery.agents);
		session.dashboard.refresh(manager);
		this.turns.addStopSequenceOnce("<agent_idle");
		const data: ResurrectResultData = {
			agents: params.agents.map((agent) => {
				const pathValue = childAgentPath(this.scopePath(), agent.id);
				const snapshot = session.registry.getSnapshot(pathValue);
				const status = manager.getAgentStatus(agent.id);
				return {
					id: agent.id,
					path: [...pathValue],
					sessionId: agent.sessionId,
					incarnation: snapshot?.incarnation ?? "",
					state: status?.state === "idle" ? "idle" : "running",
					usage: status?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					...(status?.lastOutput !== undefined ? { output: status.lastOutput } : undefined),
					...(status?.lastError !== undefined ? { error: status.lastError } : undefined),
				};
			}),
		};
		const card: SubagentCard = {
			kind: "resurrect",
			state: "complete",
			data: {
				operation: "resurrect",
				parameters: { agents: params.agents.map((agent) => ({ ...agent, ...(agent.channels ? { channels: [...agent.channels] } : undefined) })), source },
				result: {
					affectedAgents: data.agents.map((agent) => ({
						path: agent.path,
						sessionId: agent.sessionId,
						incarnation: agent.incarnation,
						state: agent.state,
						usage: agent.usage,
						...(agent.output !== undefined ? { output: agent.output } : undefined),
						...(agent.error !== undefined ? { error: agent.error } : undefined),
					})),
				},
			},
		};
		return { ...cardResult(ack, card, data), card };
	}

	private async awaitAgents(params: AwaitToolParams, signal: AbortSignal | undefined, progress: CardProgress): Promise<ToolReply> {
		const { manager } = this.requireActiveSession();
		if (!manager.hasAgents()) {throw new Error("No agents running. Spawn agents first with the subagent or fork tool.");}
		const requested = params.agents?.length ? params.agents : undefined;
		for (const id of requested ?? []) {
			if (!manager.getAgentStatus(id)) {throw new Error(`Unknown agent: "${id}"`);}
		}
		const ids = requested ?? manager.getAgentStatuses().map((status) => status.id);
		const parameters = requested ? { agents: [...requested] } : {};
		const card = (state: SubagentCard["state"], result: { statuses: readonly SubagentAgentStatus[]; interrupted?: boolean; error?: string }): SubagentCard =>
			({ kind: "await", state, data: { operation: "await", parameters, result } });
		const report = await this.turns.awaitAgents(ids, signal, (statuses) => progress(card("active", { statuses })));
		const data: AwaitResultData = {
			agents: report.statuses.map((status) => ({
				id: status.path.at(-1) ?? "",
				status: status.state,
				...(status.output !== undefined ? { output: status.output } : undefined),
				...(status.error !== undefined ? { error: status.error } : undefined),
				...(status.sessionId !== undefined ? { sessionId: status.sessionId } : undefined),
			})),
			...(report.interrupted ? { interrupted: true } : undefined),
			...(report.error !== undefined ? { error: report.error } : undefined),
		};
		const result = cardResult(report.text, card("complete", {
			statuses: report.statuses,
			...(report.interrupted ? { interrupted: true } : undefined),
			...(report.error !== undefined ? { error: report.error } : undefined),
		}), data);
		return report.receipts?.length
			? { ...result, details: { ...result.details, ...settlementReceiptDetails(report.text, report.receipts) } }
			: result;
	}

	private async interruptAgents(params: InterruptToolParams, signal: AbortSignal | undefined): Promise<ToolReply> {
		const { manager } = this.requireActiveSession();
		if (!manager.hasAgents()) {throw new Error("No agents running. Spawn agents first with the subagent or fork tool.");}
		const requested = params.agents?.length ? params.agents : undefined;
		for (const id of requested ?? []) {
			if (!manager.getAgentStatus(id)) {throw new Error(`Unknown agent: "${id}"`);}
		}
		const ids = requested ?? manager.getAgentStatuses().map((status) => status.id);
		const results = await Promise.allSettled(ids.map((id: string) => manager.interrupt(id, { signal })));
		const interrupted: { path: string[]; output?: string; error?: string }[] = [];
		const pending: { path: string[]; output?: string; error?: string }[] = [];
		const failed: { path: string[]; output?: string; error?: string }[] = [];
		results.forEach((result, index) => {
			const pathValue = childAgentPath(this.scopePath(), ids[index]);
			if (result.status !== "fulfilled") {
				failed.push({ path: [...pathValue], error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
			} else if (result.value === "pending") {pending.push({ path: [...pathValue], error: "Abort delivered but the run has not settled." });}
			else {interrupted.push({ path: [...pathValue] });}
		});
		const lines: string[] = [];
		if (interrupted.length > 0) {lines.push(`Interrupted: ${interrupted.map((item) => item.path.at(-1)).join(", ")}`);}
		if (pending.length > 0) {lines.push(
			`Abort delivered but not yet settled: ${pending.map((item) => item.path.at(-1)).join(", ")}. ` +
			"Likely stuck in a tool call that ignores cancellation. Check status before relying on it, and tear it down if it stays busy.",
		);}
		if (failed.length > 0) {lines.push(`Failed: ${failed.map((item) => `${item.path.at(-1)}: ${item.error ?? "unknown error"}`).join("; ")}`);}
		const data: InterruptResultData = { interrupted, pending, failed };
		const card: SubagentCard = {
			kind: "interrupt",
			state: "complete",
			data: { operation: "interrupt", parameters: requested ? { agents: [...requested] } : {}, result: { interrupted, pending, failed } },
		};
		return cardResult(lines.join("\n") || "No agents interrupted.", card, data);
	}

	private async restoreChildDescendants(ctx: ExtensionContext, session: ActiveSubagentSession): Promise<void> {
		if (this.scope.kind !== "child") {return;}
		if (!await this.scope.registry.waitForLiveNode(this.scope.path)) {return;}
		await session.manager.restoreFromPersistence(session.environment.discoverAgents(ctx.cwd).agents);
	}
}

/** One available model, as the registry reports it. */
type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

/** Tool parameter schemas, shared by tool registration and handler types. */
const AgentItemSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this agent among the parent's active agents" }),
	persona: Type.Optional(Type.String({ description: "Persona name — the `name` of a discovered agent definition (omit for a default general-purpose agent)" })),
	model: Type.Optional(Type.String({ description: "Tier (cheap, medium, smart, frontier) or concrete model id. A persona model pin outranks this value." })),
	task: Type.String({ description: "Task description for this agent" }),
	channels: Type.Optional(Type.Array(Type.String(), {
		description: "Peer agent ids this agent can send to. The parent is always allowed.",
	})),
	cwd: Type.Optional(Type.String({
		description:
			"Working directory for this agent. Relative paths resolve against the parent's cwd. " +
			"Defaults to the parent's cwd. The subagent boots as if pi were freshly launched in this directory — " +
			"its AGENTS.md, project agents, and project skills are discovered relative to it.",
	})),
});

const ResurrectItemSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for the resurrected agent among the parent's active agents" }),
	sessionId: Type.String({ description: "session_id surfaced by a prior teardown report" }),
	model: Type.Optional(Type.String({ description: "Tier (cheap, medium, smart, frontier) or concrete model id. Omit to keep the model the session last ran on. A persona model pin outranks this value." })),
	channels: Type.Array(Type.String(), { description: "Peer agent ids this agent can send to (re-declared fresh; siblings resurrected in the same batch are valid targets). Parent is always allowed." }),
	task: Type.String({ description: "Directive the agent runs on resurrection" }),
});

const SubagentParamsSchema = Type.Object({
	agents: Type.Array(AgentItemSchema, { description: "Agents to spawn under this parent session" }),
});

const ForkParamsSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for the forked agent" }),
	task: Type.String({ description: "Task description for the forked agent" }),
});

const SendParamsSchema = Type.Object({
	to: Type.String({ description: "Target agent id or 'parent'" }),
	message: Type.String({ description: "Message content" }),
	expectResponse: Type.Optional(Type.Boolean({ description: "Wait for a response (blocking). Default: false.", default: false })),
});

const RespondParamsSchema = Type.Object({
	correlationId: Type.String({ description: "The correlation_id from the incoming agent_message" }),
	message: Type.String({ description: "Response content" }),
});

const CheckStatusParamsSchema = Type.Object({ agent: Type.Optional(Type.String({ description: "Agent id to query. Omit for summary of all active agents." })) });

const TeardownParamsSchema = Type.Object({ agent: Type.Optional(Type.String({ description: "Agent id to remove. Omit to tear down all agents." })) });

const ResurrectParamsSchema = Type.Object({ agents: Type.Array(ResurrectItemSchema, { description: "Agents to resurrect from their session files." }) });

const AwaitParamsSchema = Type.Object({ agents: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs to wait on. Omit to wait on all active agents." })) });

const InterruptParamsSchema = Type.Object({ agents: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs to interrupt. Omit to interrupt all active agents." })) });

/** Parameters each tool handler receives, derived from its schema. */
type SubagentToolParams = Static<typeof SubagentParamsSchema>;
type ForkToolParams = Static<typeof ForkParamsSchema>;
type SendToolParams = Static<typeof SendParamsSchema>;
type RespondToolParams = Static<typeof RespondParamsSchema>;
type CheckStatusToolParams = Static<typeof CheckStatusParamsSchema>;
type TeardownToolParams = Static<typeof TeardownParamsSchema>;
type ResurrectToolParams = Static<typeof ResurrectParamsSchema>;
type AwaitToolParams = Static<typeof AwaitParamsSchema>;
type InterruptToolParams = Static<typeof InterruptParamsSchema>;

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
	if (status.agentDef) {lines.push(`Agent definition: ${status.agentDef}`);}
	if (status.model) {lines.push(`Model: ${modelDisplayName(status.model, status.thinkingLevel)}`);}
	if (status.lastActivity) {lines.push(`Last activity: ${status.lastActivity}`);}
	if (status.lastOutput) {
		const preview = status.lastOutput.length > 200 ? status.lastOutput.slice(0, 200) + "..." : status.lastOutput;
		lines.push(`Last output: ${preview}`);
	}
	const totalInput = status.usage.input + status.usage.cacheRead + status.usage.cacheWrite;
	lines.push(`Usage: ↑${totalInput} ↓${status.usage.output} $${status.usage.cost.toFixed(4)} (${status.usage.turns} turns)`);
	if (status.pendingCorrelations.length > 0) {lines.push(`Pending correlations: ${status.pendingCorrelations.join(", ")}`);}
	return lines.join("\n");
}
