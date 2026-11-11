import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEventBus,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type EventBusController,
	type ExtensionCommandContextActions,
	type ExtensionError,
	type LoadExtensionsResult,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { formatAgentPath, type AgentPath } from "./agent-path.js";
import type { ChildToolPolicy } from "./child-tool-policy.js";
import { markSubagentChildSession, type PersonaPayload } from "./child-session-marker.js";
import type { SubagentCapabilities } from "./provider.js";
import { stripThinkingSuffix } from "./model-tiers.js";
import { createSubagentsExtension, type SubagentScope } from "./scoped-extension.js";
import { registerSessionTreeStore } from "./scoped-store.js";

export type ChildSessionTarget =
	| { kind: "new"; cwd: string; sessionDir: string }
	| { kind: "resume"; sessionFile: string; sessionDir: string }
	| {
		kind: "fork";
		sourceSessionFile: string;
		cwd: string;
		sessionDir: string;
	};

export type ChildSessionConfig = {
	path: AgentPath;
	target: ChildSessionTarget;
	scope: Extract<SubagentScope, { kind: "child" }>;
	modelRef?: string;
	thinkingLevel?: ThinkingLevel;
	toolPolicy: ChildToolPolicy;
	skillPaths: string[];
	/**
	 * `skillPaths` is the complete skill set (persona-declared): suppress
	 * ordinary skill discovery even when `skillPaths` is empty — a
	 * declared-but-stale list degrades to zero skills, never to full discovery.
	 * Absent = ordinary discovery.
	 */
	noSkills?: boolean;
	appendSystemPrompt: string[];
	/** Spawn-declared persona payload recorded on the child's session manager. */
	persona?: PersonaPayload;
};

export type ChildSessionMetadata = {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
};

/** Inputs used to build capabilities owned by the child-session provider. */
export type ChildSessionCapabilityContext = Readonly<{
	session: AgentSession;
	runtime: AgentSessionRuntime;
	eventBus: EventBusController;
}>;

/**
 * A native runtime replacement. The public path and registry incarnation stay
 * outside this value. The registry owns those identities while this event
 * reports only the native object that changed.
 */
export type ChildSessionRuntimeReplaced = Readonly<{
	previousSession: AgentSession;
	session: AgentSession;
	oldSessionId: string;
	newSessionId: string;
	capabilities?: SubagentCapabilities;
}>;

export type ChildSessionHooks = {
	onEvent(event: AgentSessionEvent): void;
	/** Non-fatal setup diagnostics must not be mistaken for prompt failures. */
	onDiagnostic?(message: string, type?: "info" | "warning" | "error"): void;
	onSessionChanged(metadata: ChildSessionMetadata): void;
	/**
	 * Explicitly reports every successful native-session rebind, including a
	 * rebind whose session id, file, and cwd are unchanged.
	 */
	onRuntimeReplaced?(event: ChildSessionRuntimeReplaced): void;
	/** Build provider-owned capabilities for the current native child. */
	getCapabilities?(context: ChildSessionCapabilityContext): SubagentCapabilities;
	onShutdownRequested(): void;
};

export type ManagedChildSessionDependencies = {
	agentDir: string;
};

type BashOptions = Parameters<AgentSession["executeBash"]>[2];

const CHILD_CAPABILITY_OPERATIONS = Object.freeze([
	"prompt",
	"steer",
	"follow_up",
	"stop",
	"bash",
	"abort_bash",
	"set_model",
	"cycle_model",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_auto_compaction",
	"compact",
	"tree",
	"completion",
	"state",
	"meta",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Default capabilities are child-local and deliberately omit runtime-owner
 * operations. Owners can provide a stricter projection through getCapabilities.
 */
function createDefaultCapabilities(session: AgentSession): SubagentCapabilities {
	const executeBash = (...args: readonly unknown[]): Promise<unknown> => {
		const command = args[0];
		if (typeof command !== "string") throw new TypeError("Child bash command must be a string");
		const options = isRecord(args[1]) ? args[1] as BashOptions : undefined;
		return session.executeBash(command, undefined, options);
	};
	const abortBash = (): void => {
		session.abortBash();
	};
	return Object.freeze({
		operations: CHILD_CAPABILITY_OPERATIONS,
		renderer: Object.freeze({ visible: true }),
		resolveModel: (provider: string, modelId: string) => session.modelRuntime.getModel(provider, modelId),
		getSettings: () => ({
			availableThinkingLevels: typeof session.getAvailableThinkingLevels === "function"
				? session.getAvailableThinkingLevels()
				: [],
			autoCompactionEnabled: session.autoCompactionEnabled,
			sessionName: session.sessionName,
		}),
		nativeBash: Object.freeze({ admitted: true, execute: executeBash, abort: abortBash }),
		executeBash,
	});
}

type SessionBinding = {
	eventBus: EventBusController;
};

type RuntimeFactoryOptions = {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
};

/** Owns one SDK-native child runtime and its scoped extension lifecycle. */
export class ManagedChildSession {
	readonly runtime: AgentSessionRuntime;

	private activeEventBus: EventBusController;
	private activeSession: AgentSession;
	private activeCapabilities: SubagentCapabilities;
	private unsubscribeSession?: () => void;
	private disposal?: Promise<void>;
	private readonly hooks: ChildSessionHooks;
	private readonly bindingsBySession: WeakMap<AgentSession, SessionBinding>;

	constructor(
		runtime: AgentSessionRuntime,
		bindingsBySession: WeakMap<AgentSession, SessionBinding>,
		hooks: ChildSessionHooks,
	) {
		this.runtime = runtime;
		this.bindingsBySession = bindingsBySession;
		this.hooks = hooks;
		this.activeSession = runtime.session;
		const binding = bindingsBySession.get(runtime.session);
		if (!binding) throw new Error("Managed child session is missing runtime bindings");
		this.activeEventBus = binding.eventBus;
		// The initial bind recomputes owner capabilities after extensions are ready.
		// Keep a safe projection available for callers that inspect the object while
		// construction is still completing.
		this.activeCapabilities = createDefaultCapabilities(runtime.session);
	}

	get eventBus(): EventBusController {
		return this.activeEventBus;
	}

	get session(): AgentSession {
		return this.activeSession;
	}

	/** Provider-owned child-local operations for the currently bound session. */
	get capabilities(): SubagentCapabilities {
		return this.activeCapabilities;
	}

	get sessionId(): string {
		return this.activeSession.sessionId;
	}

	get sessionFile(): string | undefined {
		return this.activeSession.sessionFile;
	}

	submit(text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		const session = this.activeSession;
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const settlePreflight = (success: boolean): void => {
				if (settled) return;
				settled = true;
				if (success) resolve();
				else reject(new Error("Prompt rejected by child session"));
			};
			let promptResult: Promise<void> | void;
			try {
				promptResult = session.prompt(text, {
					source: "rpc",
					...(streamingBehavior ? { streamingBehavior } : {}),
					preflightResult: settlePreflight,
				});
			} catch (error) {
				if (!settled) {
					settled = true;
					reject(error);
				}
				return;
			}
			// Observe the complete run even though callers receive preflight promptly.
			Promise.resolve(promptResult).then(
				() => {
					if (!settled) settlePreflight(true);
				},
				(error) => {
					if (!settled) {
						settled = true;
						reject(error);
					}
				},
			);
		});
	}

	abort(): Promise<void> {
		return this.activeSession.abort();
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposal = (async () => {
			this.unsubscribeSession?.();
			this.unsubscribeSession = undefined;
			await this.runtime.dispose();
		})();
		return this.disposal;
	}

	private buildCapabilities(session: AgentSession): SubagentCapabilities {
		const context: ChildSessionCapabilityContext = {
			session,
			runtime: this.runtime,
			eventBus: this.activeEventBus,
		};
		return this.hooks.getCapabilities?.(context) ?? createDefaultCapabilities(session);
	}

	/** Called by AgentSessionRuntime whenever it installs a replacement session. */
	async bindSession(session: AgentSession, replacement: boolean): Promise<void> {
		const previousSession = this.activeSession;
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		const binding = this.bindingsBySession.get(session);
		if (!binding) {
			const error = new Error("Managed child session replacement is missing runtime bindings");
			if (replacement) this.reportRuntimeFailure(error);
			throw error;
		}
		this.activeEventBus = binding.eventBus;
		try {
			// Subscribe before binding so session_start work cannot outrun status hooks.
			this.unsubscribeSession = session.subscribe(this.hooks.onEvent);
			await session.bindExtensions(this.createExtensionBindings(session));
			if (typeof session.thinkingLevel === "string") {
				this.hooks.onEvent({ type: "thinking_level_changed", level: session.thinkingLevel });
			}
		} catch (error) {
			this.unsubscribeSession?.();
			this.unsubscribeSession = undefined;
			if (replacement) this.reportRuntimeFailure(error);
			throw error;
		}

		// Publish the native replacement only after the new extension context and
		// provider-owned capabilities are ready. A replacement keeps the registry
		// path and incarnation unchanged.
		let capabilities: SubagentCapabilities;
		try {
			capabilities = this.buildCapabilities(session);
		} catch (error) {
			if (replacement) this.reportRuntimeFailure(error);
			throw error;
		}
		this.activeSession = session;
		this.activeCapabilities = capabilities;
		if (replacement) {
			this.hooks.onSessionChanged({
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				cwd: session.sessionManager.getCwd(),
			});
			this.hooks.onRuntimeReplaced?.({
				previousSession,
				session,
				oldSessionId: previousSession.sessionId,
				newSessionId: session.sessionId,
				capabilities,
			});
		}
	}

	private createExtensionBindings(session: AgentSession) {
		const commandContextActions: ExtensionCommandContextActions = {
			waitForIdle: () => session.waitForIdle(),
			newSession: (options) => this.runtime.newSession(options),
			fork: (entryId, options) => this.runtime.fork(entryId, options),
			navigateTree: (targetId, options) => session.navigateTree(targetId, options),
			switchSession: (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
			reload: () => session.reload(),
		};
		return {
			mode: "print" as const,
			commandContextActions,
			abortHandler: () => {
				void session.abort().catch(() => {});
			},
			shutdownHandler: () => {
				// A shutdown request is cooperative: stop any in-flight turn before
				// the manager marks the node unavailable. Registry removal remains the
				// owner of the eventual runtime disposal.
				void session.abort().catch(() => {});
				this.hooks.onShutdownRequested();
			},
			// ExtensionRunner catches handler exceptions and continues the SDK
			// lifecycle. Report them as diagnostics; prompt errors come from the
			// child's own lifecycle events.
			onError: (error: ExtensionError) => notifyDiagnostic(this.hooks, error.error, "error"),
		};
	}

	private reportRuntimeFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		notifyDiagnostic(this.hooks, message, "error");
		this.hooks.onShutdownRequested();
	}
}

const ROOT_SUBAGENTS_EXTENSION_PATH = normalizePath(fileURLToPath(new URL("./index.ts", import.meta.url)));
const CHILD_SUBAGENTS_EXTENSION_PATH = "<inline:subagents-child>";
function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}
function notifyDiagnostic(
	hooks: ChildSessionHooks,
	message: string,
	type: "info" | "warning" | "error" = "warning",
): void {
	hooks.onDiagnostic?.(message, type);
}

function reportRuntimeDiagnostics(
	diagnostics: readonly { type?: string; message?: string }[] | undefined,
	hooks: ChildSessionHooks,
): void {
	for (const diagnostic of diagnostics ?? []) {
		if (!diagnostic?.message) continue;
		const type = diagnostic.type === "info" || diagnostic.type === "error" || diagnostic.type === "warning"
			? diagnostic.type
			: "warning";
		notifyDiagnostic(hooks, diagnostic.message, type);
	}
}

function reportExtensionDiagnostics(
	diagnostics: readonly { path?: string; error?: string }[] | undefined,
	hooks: ChildSessionHooks,
): void {
	for (const diagnostic of diagnostics ?? []) {
		if (!diagnostic?.error) continue;
		// The SDK computes conflict diagnostics before applying extensionsOverride.
		// Child runtimes intentionally remove the discovered root subagents
		// extension and inject one scoped factory, so conflicts that mention that
		// filtered path are stale loader diagnostics rather than live failures.
		if (diagnostic.error.includes(ROOT_SUBAGENTS_EXTENSION_PATH)) continue;
		const prefix = diagnostic.path ? `${diagnostic.path}: ` : "";
		notifyDiagnostic(hooks, `${prefix}${diagnostic.error}`, "error");
	}
}

function isRootSubagentsExtension(extension: { path?: string; resolvedPath?: string }): boolean {
	return [extension.resolvedPath, extension.path]
		.filter((candidate): candidate is string => candidate !== undefined)
		.map(normalizePath)
		.some((candidate) => candidate === ROOT_SUBAGENTS_EXTENSION_PATH);
}
function isChildSubagentsExtension(extension: { path?: string; resolvedPath?: string }): boolean {
	return [extension.resolvedPath, extension.path]
		.filter((candidate): candidate is string => candidate !== undefined)
		.map(normalizePath)
		.some((candidate) => candidate === CHILD_SUBAGENTS_EXTENSION_PATH);
}
function createExtensionsOverride(base: LoadExtensionsResult): LoadExtensionsResult {
	const extensions = base.extensions.filter((extension) => !isRootSubagentsExtension(extension));
	// Startup extensions can trigger a turn. Bind the scoped owner first so
	// those turns cannot observe a child before its lifecycle is ready.
	const childIndex = extensions.findIndex(isChildSubagentsExtension);
	if (childIndex > 0) {
		const [child] = extensions.splice(childIndex, 1);
		extensions.unshift(child);
	}
	return { ...base, extensions };
}

function initialTarget(target: ChildSessionTarget): {
	sessionManager: SessionManager;
	cwd: string;
	reason: SessionStartEvent["reason"];
} {
	switch (target.kind) {
		case "new": {
			const sessionManager = SessionManager.create(target.cwd, target.sessionDir);
			return { sessionManager, cwd: target.cwd, reason: "startup" };
		}
		case "resume": {
			const sessionManager = SessionManager.open(target.sessionFile, target.sessionDir);
			return { sessionManager, cwd: sessionManager.getCwd(), reason: "resume" };
		}
		case "fork": {
			const sessionManager = SessionManager.forkFrom(target.sourceSessionFile, target.cwd, target.sessionDir);
			return { sessionManager, cwd: target.cwd, reason: "fork" };
		}
	}
}

export async function createManagedChildSession(
	config: ChildSessionConfig,
	dependencies: ManagedChildSessionDependencies,
	hooks: ChildSessionHooks,
): Promise<ManagedChildSession> {
	const skillPaths = [...config.skillPaths];
	const appendSystemPrompt = [...config.appendSystemPrompt];
	const initial = initialTarget(config.target);
	const pathName = formatAgentPath(config.path);
	const bindingsBySession = new WeakMap<AgentSession, SessionBinding>();
	let live = false;
	let managed: ManagedChildSession | undefined;

	const createRuntime = async (options: RuntimeFactoryOptions) => {
		// Mark before any extension session-start dispatch: covers the initial
		// manager and every SDK replacement session alike.
		markSubagentChildSession(options.sessionManager, config.persona);
		try {
			options.sessionManager.appendSessionInfo(pathName);
			const effectiveCwd = options.sessionManager.getCwd() || options.cwd;
			const settingsManager = SettingsManager.create(effectiveCwd, options.agentDir);
			const eventBus = createEventBus();
			const resourceLoaderOptions = {
				eventBus,
				appendSystemPrompt,
				extensionFactories: [{ name: "subagents-child", factory: createSubagentsExtension(config.scope) }],
				extensionsOverride: createExtensionsOverride,
				// `noSkills` (persona-declared set) or a non-empty list pins the exact
				// skill set; an empty undeclared list leaves ordinary discovery intact.
				...(config.noSkills || skillPaths.length > 0
					? {
							noSkills: true,
							...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
						}
					: {}),
			};
			// No trust hook: pi's default project-trusted state stands, so the
			// child trusts its cwd and loads all project resources there
			// (.pi/settings.json, .pi/extensions, .pi/skills, .pi/mcp.json, …).
			// The former cautious ask→no headless adapter is deliberately gone.
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				agentDir: options.agentDir,
				settingsManager,
				resourceLoaderOptions,
			});
			reportRuntimeDiagnostics(services.diagnostics, hooks);
			const treeStore = config.scope.registry.getScopedStore?.();
			const forced = treeStore?.get("forced-model");
			const effectiveModelRef = forced ?? config.modelRef;
			const modelResult = effectiveModelRef === undefined
				? undefined
				: resolveCliModel({ cliModel: effectiveModelRef, modelRuntime: services.modelRuntime });
			if (modelResult?.error) throw new Error(modelResult.error);
			// A forced model is authoritative: when the operator's `/fmodel` value
			// carries a thinking level, that level outranks every level the
			// construction resolved (a fork's inherited level, a persona pin's).
			const forcedThinking = typeof forced === "string" ? stripThinkingSuffix(forced).thinking : undefined;
			const thinkingLevel = forcedThinking ?? config.thinkingLevel ?? modelResult?.thinkingLevel;
			const sessionResult = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				...(modelResult?.model ? { model: modelResult.model } : {}),
				...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
				...(config.toolPolicy.allowedTools !== undefined
					? { tools: config.toolPolicy.allowedTools }
					: { excludeTools: config.toolPolicy.excludeTools }),
				sessionStartEvent: options.sessionStartEvent,
			});
			if (treeStore) {
				registerSessionTreeStore(options.sessionManager, treeStore);
			}
			reportExtensionDiagnostics(sessionResult.extensionsResult?.errors, hooks);
			bindingsBySession.set(sessionResult.session, { eventBus });
			return { ...sessionResult, services, diagnostics: services.diagnostics };
		} catch (error) {
			if (live) {
				const message = error instanceof Error ? error.message : String(error);
				notifyDiagnostic(hooks, message, "error");
				hooks.onShutdownRequested();
			}
			throw error;
		}
	};

	let runtime: AgentSessionRuntime | undefined;
	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: initial.cwd,
			agentDir: dependencies.agentDir,
			sessionManager: initial.sessionManager,
			sessionStartEvent: { type: "session_start", reason: initial.reason },
		});
		managed = new ManagedChildSession(runtime, bindingsBySession, hooks);
		runtime.setRebindSession((session) => managed!.bindSession(session, true));
		await managed.bindSession(runtime.session, false);
		live = true;
		return managed;
	} catch (error) {
		if (runtime) {
			try {
				await runtime.dispose();
			} catch {
				// Preserve the initial failure.
			}
		}
		throw error;
	}
}
