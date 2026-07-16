import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEventBus,
	ProjectTrustStore,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AuthStorage,
	type EventBusController,
	type ExtensionCommandContextActions,
	type ExtensionError,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type ModelRegistry,
	type ProjectTrustContext,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { formatAgentPath, type AgentPath } from "./agent-path.js";
import type { ChildToolPolicy } from "./child-tool-policy.js";
import { DelegatingExtensionUI } from "./delegating-extension-ui.js";
import { createSubagentsExtension, type SubagentScope } from "./scoped-extension.js";
import { resolveChildProjectTrust } from "./project-trust.js";

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
	appendSystemPrompt: string[];
};

export type ChildSessionHooks = {
	onEvent(event: AgentSessionEvent): void;
	onUiNotify(message: string, type?: "info" | "warning" | "error"): void;
	/** Non-fatal setup diagnostics must not be mistaken for prompt failures. */
	onDiagnostic?(message: string, type?: "info" | "warning" | "error"): void;
	onSessionChanged(metadata: {
		sessionId: string;
		sessionFile?: string;
		cwd: string;
	}): void;
	onShutdownRequested(): void;
};

export type ManagedChildSessionDependencies = {
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
};

type SessionBinding = {
	eventBus: EventBusController;
	uiContext: ExtensionUIContext;
};

type RuntimeFactoryOptions = {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
};

/** Owns one SDK-native child runtime and its scoped extension lifecycle. */
export class ManagedChildSession {
	readonly runtime: AgentSessionRuntime;
	readonly presentation: DelegatingExtensionUI;

	private activeEventBus: EventBusController;
	private unsubscribeSession?: () => void;
	private disposal?: Promise<void>;
	private readonly hooks: ChildSessionHooks;
	private readonly bindingsBySession: WeakMap<AgentSession, SessionBinding>;

	constructor(
		runtime: AgentSessionRuntime,
		bindingsBySession: WeakMap<AgentSession, SessionBinding>,
		presentation: DelegatingExtensionUI,
		hooks: ChildSessionHooks,
	) {
		this.runtime = runtime;
		this.bindingsBySession = bindingsBySession;
		this.presentation = presentation;
		this.hooks = hooks;
		const binding = bindingsBySession.get(runtime.session);
		if (!binding) throw new Error("Managed child session is missing runtime bindings");
		this.activeEventBus = binding.eventBus;
	}

	get eventBus(): EventBusController {
		return this.activeEventBus;
	}

	get session(): AgentSession {
		return this.runtime.session;
	}

	get sessionId(): string {
		return this.runtime.session.sessionId;
	}

	get sessionFile(): string | undefined {
		return this.runtime.session.sessionFile;
	}

	submit(text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		const session = this.runtime.session;
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
		return this.runtime.session.abort();
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

	/** Called by AgentSessionRuntime whenever it installs a replacement session. */
	async bindSession(session: AgentSession, replacement: boolean): Promise<void> {
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
		} catch (error) {
			this.unsubscribeSession?.();
			this.unsubscribeSession = undefined;
			if (replacement) this.reportRuntimeFailure(error);
			throw error;
		}
		if (replacement) {
			this.hooks.onSessionChanged({
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				cwd: session.sessionManager.getCwd(),
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
			mode: "rpc" as const,
			uiContext: this.presentation.context,
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
			onError: (error: ExtensionError) => this.hooks.onUiNotify(error.error, "error"),
		};
	}

	private reportRuntimeFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.hooks.onUiNotify(message, "error");
		this.hooks.onShutdownRequested();
	}
}

function createHeadlessUi(onUiNotify: ChildSessionHooks["onUiNotify"]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => onUiNotify(message, type),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return undefined as never;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

const ROOT_SUBAGENTS_EXTENSION_PATH = normalizePath(fileURLToPath(new URL("./index.ts", import.meta.url)));
function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}
function notifyDiagnostic(
	hooks: ChildSessionHooks,
	message: string,
	type: "info" | "warning" | "error" = "warning",
): void {
	if (hooks.onDiagnostic) {
		hooks.onDiagnostic(message, type);
		return;
	}
	// Older manager hooks only expose UI notifications. Surface setup failures
	// as warnings there: they are diagnostics, not prompt preflight failures.
	hooks.onUiNotify(message, type === "error" ? "warning" : type);
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
function createExtensionsOverride(base: LoadExtensionsResult): LoadExtensionsResult {
	return { ...base, extensions: base.extensions.filter((extension) => !isRootSubagentsExtension(extension)) };
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
	const trustStore = new ProjectTrustStore(dependencies.agentDir);
	const initial = initialTarget(config.target);
	const pathName = formatAgentPath(config.path);
	const headless = createHeadlessUi(hooks.onUiNotify);
	const presentation = new DelegatingExtensionUI({ headless });
	const bindingsBySession = new WeakMap<AgentSession, SessionBinding>();
	let live = false;
	let managed: ManagedChildSession | undefined;

	const createRuntime = async (options: RuntimeFactoryOptions) => {
		try {
			options.sessionManager.appendSessionInfo(pathName);
			const effectiveCwd = options.sessionManager.getCwd() || options.cwd;
			const settingsManager = SettingsManager.create(effectiveCwd, options.agentDir);
			const eventBus = createEventBus();
			const projectTrustContext: ProjectTrustContext = {
				cwd: effectiveCwd,
				mode: "rpc",
				hasUI: false,
				ui: presentation.context,
			};
			const resourceLoaderOptions = {
				eventBus,
				appendSystemPrompt,
				extensionFactories: [{ name: "subagents-child", factory: createSubagentsExtension(config.scope) }],
				extensionsOverride: createExtensionsOverride,
				...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths, noSkills: true } : {}),
			};
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				agentDir: options.agentDir,
				authStorage: dependencies.authStorage,
				modelRegistry: dependencies.modelRegistry,
				settingsManager,
				resourceLoaderOptions,
				resourceLoaderReloadOptions: {
					resolveProjectTrust: ({ extensionsResult }) => resolveChildProjectTrust({
						cwd: effectiveCwd,
						extensionsResult,
						trustStore,
						defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
						projectTrustContext,
						onExtensionError: (error) => notifyDiagnostic(hooks, error.error, "error"),
					}),
				},
			});
			reportRuntimeDiagnostics(services.diagnostics, hooks);
			const modelResult = config.modelRef === undefined
				? undefined
				: await resolveCliModel({ cliModel: config.modelRef, modelRegistry: dependencies.modelRegistry });
			if (modelResult?.error) throw new Error(modelResult.error);
			const sessionResult = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				...(modelResult?.model ? { model: modelResult.model } : {}),
				...(config.thinkingLevel !== undefined || modelResult?.thinkingLevel !== undefined
					? { thinkingLevel: config.thinkingLevel ?? modelResult?.thinkingLevel }
					: {}),
				...(config.toolPolicy.allowedTools !== undefined
					? { tools: config.toolPolicy.allowedTools }
					: { excludeTools: config.toolPolicy.excludeTools }),
				sessionStartEvent: options.sessionStartEvent,
			});
			reportExtensionDiagnostics(sessionResult.extensionsResult?.errors, hooks);
			bindingsBySession.set(sessionResult.session, { eventBus, uiContext: presentation.context });
			return { ...sessionResult, services, diagnostics: services.diagnostics };
		} catch (error) {
			if (live) {
				const message = error instanceof Error ? error.message : String(error);
				hooks.onUiNotify(message, "error");
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
		managed = new ManagedChildSession(runtime, bindingsBySession, presentation, hooks);
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
