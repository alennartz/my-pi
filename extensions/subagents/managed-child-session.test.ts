import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAgentPath } from "./agent-path.js";
import type { MessagePort } from "./message-router.js";

const sdk = vi.hoisted(() => {
	let sequence = 0;
	const state: {
		managers: any[];
		servicesArgs: any[];
		sessionArgs: any[];
		runtimeArgs: any[];
		sessions: any[];
		runtimes: any[];
		bindings: Array<{ session: any; bindings: any }>;
		eventDuringBind?: any;
		defaultProjectTrust: "ask" | "always" | "never";
		trustStoreInstances: any[];
		promptImplementation: (session: any, text: string, options: any) => Promise<void>;
	} = {
		managers: [],
		servicesArgs: [],
		sessionArgs: [],
		runtimeArgs: [],
		sessions: [],
		runtimes: [],
		bindings: [],
		eventDuringBind: undefined,
		defaultProjectTrust: "ask",
		trustStoreInstances: [],
		promptImplementation: async (_session, _text, options) => {
			options?.preflightResult?.(true);
		},
	};

	function makeManager(kind: string, input: Record<string, any>) {
		const sessionId = `${kind}-${++sequence}`;
		const cwd = kind === "resume" ? "/resumed-project" : input.cwd;
		const sessionFile = kind === "resume"
			? input.sessionFile
			: `${input.sessionDir}/${sessionId}.jsonl`;
		const manager = {
			kind,
			input,
			appendSessionInfo: vi.fn(),
			getCwd: vi.fn(() => cwd),
			getSessionDir: vi.fn(() => input.sessionDir),
			getSessionFile: vi.fn(() => sessionFile),
			getSessionId: vi.fn(() => sessionId),
		};
		state.managers.push(manager);
		return manager;
	}

	const SessionManager = {
		create: vi.fn((cwd: string, sessionDir: string) => makeManager("new", { cwd, sessionDir })),
		open: vi.fn((sessionFile: string, sessionDir: string) => makeManager("resume", { sessionFile, sessionDir })),
		forkFrom: vi.fn((sourceSessionFile: string, cwd: string, sessionDir: string) =>
			makeManager("fork", { sourceSessionFile, cwd, sessionDir }),
		),
	};

	class ProjectTrustStore {
		constructor(agentDir: string) {
			state.trustStoreInstances.push({ agentDir, store: this });
		}

		get = vi.fn(() => null);
		set = vi.fn();
	}

	const createEventBus = vi.fn(() => ({
		on: vi.fn(() => () => {}),
		emit: vi.fn(),
	}));

	function makeSession(sessionManager: any) {
		const listeners = new Set<(event: any) => void>();
		const session: any = {
			sessionId: sessionManager.getSessionId(),
			sessionFile: sessionManager.getSessionFile(),
			sessionManager,
			prompt: vi.fn((text: string, options: any) => state.promptImplementation(session, text, options)),
			abort: vi.fn(async () => {}),
			subscribe: vi.fn((listener: (event: any) => void) => {
				listeners.add(listener);
				const unsubscribe = vi.fn(() => listeners.delete(listener));
				return unsubscribe;
			}),
			bindExtensions: vi.fn(async (bindings: any) => {
				state.bindings.push({ session, bindings });
				if (state.eventDuringBind) {
					for (const listener of listeners) listener(state.eventDuringBind);
				}
			}),
			emit(event: any) {
				for (const listener of listeners) listener(event);
			},
		};
		state.sessions.push(session);
		return session;
	}

	const createAgentSessionServices = vi.fn(async (options: any) => {
		state.servicesArgs.push(options);
		return {
			cwd: options.cwd,
			agentDir: options.agentDir,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			settingsManager: {
				getDefaultProjectTrust: vi.fn(() => state.defaultProjectTrust),
			},
			resourceLoader: {
				getExtensions: vi.fn(() => ({ extensions: [], errors: [] })),
			},
			diagnostics: [],
		};
	});

	const createAgentSessionFromServices = vi.fn(async (options: any) => {
		state.sessionArgs.push(options);
		return {
			session: makeSession(options.sessionManager),
			extensionsResult: { extensions: [], errors: [] },
		};
	});

	const createAgentSessionRuntime = vi.fn(async (factory: any, options: any) => {
		state.runtimeArgs.push({ factory, options });
		const created = await factory({
			...options,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		let rebindSession: ((session: any) => Promise<void>) | undefined;
		const runtime: any = {
			session: created.session,
			services: created.services,
			get cwd() {
				return runtime.services.cwd;
			},
			setRebindSession: vi.fn((handler: (session: any) => Promise<void>) => {
				rebindSession = handler;
			}),
			dispose: vi.fn(async () => {}),
			newSession: vi.fn(async () => {
				const replacementManager = makeManager("replacement", {
					cwd: "/replacement-project",
					sessionDir: "/sessions",
				});
				const replacement = await factory({
					...options,
					cwd: "/replacement-project",
					sessionManager: replacementManager,
					sessionStartEvent: { type: "session_start", reason: "new" },
				});
				runtime.session = replacement.session;
				runtime.services = replacement.services;
				await rebindSession?.(replacement.session);
			}),
		};
		state.runtimes.push(runtime);
		return runtime;
	});

	const resolveCliModel = vi.fn(({ cliModel }: { cliModel: string }) => {
		const [modelRef, thinkingLevel] = cliModel.split(":");
		return {
			model: { provider: "provider", id: modelRef.split("/").at(-1) },
			thinkingLevel,
		};
	});

	function reset() {
		sequence = 0;
		state.managers.length = 0;
		state.servicesArgs.length = 0;
		state.sessionArgs.length = 0;
		state.runtimeArgs.length = 0;
		state.sessions.length = 0;
		state.runtimes.length = 0;
		state.bindings.length = 0;
		state.eventDuringBind = undefined;
		state.defaultProjectTrust = "ask";
		state.trustStoreInstances.length = 0;
		state.promptImplementation = async (_session, _text, options) => {
			options?.preflightResult?.(true);
		};
		for (const mock of [
			SessionManager.create,
			SessionManager.open,
			SessionManager.forkFrom,
			createEventBus,
			createAgentSessionServices,
			createAgentSessionFromServices,
			createAgentSessionRuntime,
			resolveCliModel,
		]) {
			mock.mockClear();
		}
	}

	return {
		state,
		reset,
		SessionManager,
		createEventBus,
		createAgentSessionServices,
		createAgentSessionFromServices,
		createAgentSessionRuntime,
		resolveCliModel,
		ProjectTrustStore,
		SettingsManager: { create: vi.fn(() => ({ getDefaultProjectTrust: () => state.defaultProjectTrust })) },
		getAgentDir: vi.fn(() => "/agent-dir"),
	};
});

const childTrust = vi.hoisted(() => {
	const resolveChildProjectTrust = vi.fn(async () => false);
	return {
		resolveChildProjectTrust,
		reset() {
			resolveChildProjectTrust.mockClear();
			resolveChildProjectTrust.mockImplementation(async () => false);
		},
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: sdk.SessionManager,
	createEventBus: sdk.createEventBus,
	createAgentSessionServices: sdk.createAgentSessionServices,
	createAgentSessionFromServices: sdk.createAgentSessionFromServices,
	createAgentSessionRuntime: sdk.createAgentSessionRuntime,
	resolveCliModel: sdk.resolveCliModel,
	ProjectTrustStore: sdk.ProjectTrustStore,
	SettingsManager: sdk.SettingsManager,
	getAgentDir: sdk.getAgentDir,
}));

vi.mock("./project-trust.js", () => ({
	resolveChildProjectTrust: childTrust.resolveChildProjectTrust,
}));

import {
	createManagedChildSession,
	type ChildSessionConfig,
	type ChildSessionHooks,
	type ManagedChildSession,
	type ManagedChildSessionDependencies,
} from "./managed-child-session.js";

const uplink = {} as MessagePort;
const registry = {} as ChildSessionConfig["scope"]["registry"];
let children: ManagedChildSession[] = [];

function makeConfig(
	target: ChildSessionConfig["target"],
	overrides: Partial<ChildSessionConfig> = {},
): ChildSessionConfig {
	return {
		path: ["researcher", "worker"],
		target,
		scope: {
			kind: "child",
			registry,
			path: ["researcher", "worker"],
			identity: {
				id: "worker",
				task: "inspect the change",
				channels: ["parent"],
			},
			uplink,
		},
		modelRef: "provider/model:xhigh",
		toolPolicy: {
			allowedTools: ["read", "send", "respond"],
			excludeTools: undefined,
		},
		skillPaths: ["/repo/skills/debugging/SKILL.md"],
		appendSystemPrompt: ["You are a child session."],
		...overrides,
	};
}

function makeDependencies(): ManagedChildSessionDependencies {
	return {
		agentDir: "/agent-dir",
		authStorage: { marker: "shared-auth" } as ManagedChildSessionDependencies["authStorage"],
		modelRegistry: { marker: "shared-registry" } as ManagedChildSessionDependencies["modelRegistry"],
	};
}

function makeHooks(): ChildSessionHooks {
	return {
		onEvent: vi.fn(),
		onUiNotify: vi.fn(),
		onSessionChanged: vi.fn(),
		onShutdownRequested: vi.fn(),
	};
}

async function createChild(
	target: ChildSessionConfig["target"],
	overrides: Partial<ChildSessionConfig> = {},
	hooks = makeHooks(),
): Promise<{ child: ManagedChildSession; hooks: ChildSessionHooks; dependencies: ManagedChildSessionDependencies }> {
	const dependencies = makeDependencies();
	const child = await createManagedChildSession(makeConfig(target, overrides), dependencies, hooks);
	children.push(child);
	return { child, hooks, dependencies };
}

beforeEach(() => {
	sdk.reset();
	childTrust.reset();
	children = [];
});

afterEach(async () => {
	await Promise.all(children.map((child) => child.dispose()));
});

describe("createManagedChildSession construction", () => {
	it("maps new, resume, and fork targets to their SDK session-manager operations", async () => {
		const fresh = await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });
		expect(sdk.SessionManager.create).toHaveBeenCalledWith("/repo", "/sessions");
		expect(sdk.state.managers[0].appendSessionInfo).toHaveBeenCalledWith(formatAgentPath(["researcher", "worker"]));
		expect(fresh.child.sessionId).toBe("new-1");
		expect(fresh.child.sessionFile).toBe("/sessions/new-1.jsonl");

		const resumed = await createChild({
			kind: "resume",
			sessionFile: "/sessions/rpc-created.jsonl",
			sessionDir: "/sessions",
		});
		expect(sdk.SessionManager.open).toHaveBeenCalledWith("/sessions/rpc-created.jsonl", "/sessions");
		expect(sdk.state.servicesArgs[1]).toMatchObject({ cwd: "/resumed-project" });
		expect(sdk.state.managers[1].appendSessionInfo).toHaveBeenCalledWith(formatAgentPath(["researcher", "worker"]));
		expect(resumed.child.sessionFile).toBe("/sessions/rpc-created.jsonl");

		const forked = await createChild({
			kind: "fork",
			sourceSessionFile: "/parent.jsonl",
			cwd: "/fork-project",
			sessionDir: "/sessions",
		});
		expect(sdk.SessionManager.forkFrom).toHaveBeenCalledWith("/parent.jsonl", "/fork-project", "/sessions");
		expect(sdk.state.managers[2].appendSessionInfo).toHaveBeenCalledWith(formatAgentPath(["researcher", "worker"]));
		expect(forked.child.sessionFile).toBe("/sessions/fork-3.jsonl");
	});

	it("uses the escaped canonical path as the initial name for delimiter-bearing IDs", async () => {
		const agentPath = ["researcher/team", "worker"] as const;
		await createChild(
			{ kind: "new", cwd: "/repo", sessionDir: "/sessions" },
			{
				path: agentPath,
				scope: {
					...makeConfig({ kind: "new", cwd: "/repo", sessionDir: "/sessions" }).scope,
					path: agentPath,
					identity: { id: "worker", task: "inspect the change", channels: ["parent"] },
				},
			},
		);
		expect(sdk.state.managers[0].appendSessionInfo).toHaveBeenCalledWith(formatAgentPath(agentPath));
	});

	it("passes shared SDK infrastructure and one normalized tool policy into the child runtime", async () => {
		const { dependencies } = await createChild(
			{ kind: "new", cwd: "/repo", sessionDir: "/sessions" },
			{
				path: ["researcher", "worker"],
				toolPolicy: {
					allowedTools: ["read", "send", "respond"],
					excludeTools: undefined,
				},
			},
		);

		expect(sdk.resolveCliModel).toHaveBeenCalledWith(expect.objectContaining({
			cliModel: "provider/model:xhigh",
			modelRegistry: dependencies.modelRegistry,
		}));
		const services = sdk.state.servicesArgs[0];
		expect(services).toMatchObject({
			cwd: "/repo",
			agentDir: "/agent-dir",
			authStorage: dependencies.authStorage,
			modelRegistry: dependencies.modelRegistry,
		});
		expect(services.resourceLoaderOptions).toMatchObject({
			noSkills: true,
			additionalSkillPaths: ["/repo/skills/debugging/SKILL.md"],
			appendSystemPrompt: ["You are a child session."],
		});
		expect(services.resourceLoaderOptions.extensionFactories).toHaveLength(1);
		expect(services.resourceLoaderOptions.extensionsOverride).toEqual(expect.any(Function));

		const sessionOptions = sdk.state.sessionArgs[0];
		expect(sessionOptions).toMatchObject({
			model: { provider: "provider", id: "model" },
			tools: ["read", "send", "respond"],
			thinkingLevel: "xhigh",
		});
		expect(sessionOptions.excludeTools).toBeUndefined();

		await createChild(
			{ kind: "new", cwd: "/repo", sessionDir: "/sessions" },
			{ toolPolicy: { allowedTools: undefined, excludeTools: ["ask_user"] } },
		);
		expect(sdk.state.sessionArgs[1].excludeTools).toEqual(["ask_user"]);

		await createChild(
			{ kind: "new", cwd: "/repo", sessionDir: "/sessions" },
			{ skillPaths: [] },
		);
		expect(sdk.state.servicesArgs[2].resourceLoaderOptions.noSkills).not.toBe(true);
		expect(sdk.state.servicesArgs[2].resourceLoaderOptions.additionalSkillPaths).toBeUndefined();
	});

	it("isolates cwd-bound services for sibling children while sharing root auth and models", async () => {
		const dependencies = makeDependencies();
		const target: ChildSessionConfig["target"] = { kind: "new", cwd: "/repo", sessionDir: "/sessions" };
		const first = await createManagedChildSession(makeConfig(target), dependencies, makeHooks());
		const secondConfig = makeConfig(target);
		secondConfig.path = ["researcher", "reviewer"];
		secondConfig.scope = {
			...secondConfig.scope,
			path: ["researcher", "reviewer"],
			identity: { id: "reviewer", task: "review the change", channels: ["parent"] },
		};
		const second = await createManagedChildSession(secondConfig, dependencies, makeHooks());
		children.push(first, second);

		expect(sdk.createEventBus).toHaveBeenCalledTimes(2);
		expect(first.eventBus).not.toBe(second.eventBus);
		expect((first.runtime as any).services.settingsManager).not.toBe(
			(second.runtime as any).services.settingsManager,
		);
		expect(sdk.state.servicesArgs[0].resourceLoaderOptions.eventBus).not.toBe(
			sdk.state.servicesArgs[1].resourceLoaderOptions.eventBus,
		);
		expect(sdk.state.servicesArgs[0].authStorage).toBe(dependencies.authStorage);
		expect(sdk.state.servicesArgs[1].authStorage).toBe(dependencies.authStorage);
		expect(sdk.state.servicesArgs[0].modelRegistry).toBe(dependencies.modelRegistry);
		expect(sdk.state.servicesArgs[1].modelRegistry).toBe(dependencies.modelRegistry);
	});

	it("delegates child trust resolution to the local headless trust module", async () => {
		sdk.state.defaultProjectTrust = "ask";
		const extensionsResult = { extensions: [], errors: [], runtime: {} };
		await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });
		const resolveProjectTrust = sdk.state.servicesArgs.at(-1)?.resourceLoaderReloadOptions?.resolveProjectTrust;
		expect(resolveProjectTrust).toEqual(expect.any(Function));
		await expect(resolveProjectTrust({ extensionsResult })).resolves.toBe(false);

		expect(sdk.state.trustStoreInstances).toHaveLength(1);
		expect(sdk.state.trustStoreInstances[0].agentDir).toBe("/agent-dir");
		expect(childTrust.resolveChildProjectTrust).toHaveBeenCalledWith(expect.objectContaining({
			cwd: "/repo",
			extensionsResult,
			defaultProjectTrust: "ask",
			trustStore: sdk.state.trustStoreInstances[0].store,
			projectTrustContext: expect.objectContaining({ mode: "rpc", hasUI: false }),
		}));

		const bindings = sdk.state.bindings[0].bindings;
		await expect(bindings.uiContext.confirm({ message: "trust this project?" })).resolves.toBe(false);
	});
});

describe("ManagedChildSession prompt, event, and shutdown behavior", () => {
	it("returns after prompt preflight while forwarding RPC input source and streaming behavior", async () => {
		let releaseRun!: () => void;
		const run = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		sdk.state.promptImplementation = async (_session, _text, options) => {
			options.preflightResult?.(true);
			await run;
		};
		const { child } = await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });

		let submitted = false;
		const submitting = child.submit("continue", "steer").then(() => {
			submitted = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(submitted).toBe(true);
		expect(sdk.state.sessions[0].prompt).toHaveBeenCalledWith("continue", expect.objectContaining({
			source: "rpc",
			streamingBehavior: "steer",
			preflightResult: expect.any(Function),
		}));

		releaseRun();
		await submitting;
		await child.submit("follow up", "followUp");
		expect(sdk.state.sessions[0].prompt).toHaveBeenLastCalledWith("follow up", expect.objectContaining({
			source: "rpc",
			streamingBehavior: "followUp",
		}));
	});

	it("rejects prompt preflight failures and observes later run failures", async () => {
		const { child } = await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });
		sdk.state.promptImplementation = async () => {
			throw new Error("preflight rejected");
		};
		await expect(child.submit("blocked")).rejects.toThrow("preflight rejected");

		let resolveRun!: () => void;
		let observeRejection: ((error: Error) => unknown) | undefined;
		const run = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		const trackedRun: any = {
			then(onFulfilled: unknown, onRejected: ((error: Error) => unknown) | undefined) {
				observeRejection = onRejected;
				return run.then(onFulfilled as any, onRejected as any);
			},
			catch(onRejected: (error: Error) => unknown) {
				observeRejection = onRejected;
				return run.catch(onRejected);
			},
		};
		sdk.state.promptImplementation = (_session, _text, options) => {
			options.preflightResult?.(true);
			return trackedRun;
		};
		await expect(child.submit("accepted")).resolves.toBeUndefined();
		expect(observeRejection).toEqual(expect.any(Function));
		expect(() => observeRejection!(new Error("later run failure"))).not.toThrow();
		resolveRun();
	});

	it("subscribes before binding headless extensions and forwards their hooks", async () => {
		sdk.state.eventDuringBind = { type: "session_start", reason: "startup" };
		const hooks = makeHooks();
		await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" }, {}, hooks);

		expect(hooks.onEvent).toHaveBeenCalledWith(sdk.state.eventDuringBind);
		const bindings = sdk.state.bindings[0].bindings;
		expect(bindings).toMatchObject({
			mode: "rpc",
			uiContext: expect.any(Object),
			abortHandler: expect.any(Function),
			shutdownHandler: expect.any(Function),
			onError: expect.any(Function),
		});

		bindings.uiContext.notify("blocked before agent_start", "error");
		expect(hooks.onUiNotify).toHaveBeenCalledWith("blocked before agent_start", "error");
		await bindings.shutdownHandler();
		expect(hooks.onShutdownRequested).toHaveBeenCalledTimes(1);
	});

	it("rebinds the same wrapper and presentation delegate after session replacement", async () => {
		const hooks = makeHooks();
		const { child } = await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" }, {}, hooks);
		const oldSession = child.session as any;
		const initialContext = sdk.state.bindings[0].bindings.uiContext;
		expect(child.presentation).toBeDefined();

		await child.runtime.newSession();

		expect(child.session).toBe(child.runtime.session);
		expect(child.sessionId).toBe("replacement-2");
		expect(child.sessionFile).toBe("/sessions/replacement-2.jsonl");
		expect(hooks.onSessionChanged).toHaveBeenCalledWith({
			sessionId: "replacement-2",
			sessionFile: "/sessions/replacement-2.jsonl",
			cwd: "/replacement-project",
		});
		expect(sdk.state.managers[1].appendSessionInfo).toHaveBeenCalledWith(formatAgentPath(["researcher", "worker"]));
		expect(oldSession.subscribe.mock.results[0].value).toHaveBeenCalledTimes(1);
		expect(sdk.createEventBus).toHaveBeenCalledTimes(2);
		expect(sdk.state.servicesArgs[1].resourceLoaderOptions.eventBus).not.toBe(
			sdk.state.servicesArgs[0].resourceLoaderOptions.eventBus,
		);
		expect(sdk.state.servicesArgs[1].authStorage).toBe(sdk.state.servicesArgs[0].authStorage);
		expect(sdk.state.servicesArgs[1].modelRegistry).toBe(sdk.state.servicesArgs[0].modelRegistry);
		expect(sdk.state.bindings).toHaveLength(2);
		expect(sdk.state.bindings[1].bindings.uiContext).toBe(initialContext);

		oldSession.emit({ type: "agent_start" });
		expect(hooks.onEvent).not.toHaveBeenCalledWith({ type: "agent_start" });
		const currentSession = child.session as any;
		currentSession.emit({ type: "agent_start" });
		expect(hooks.onEvent).toHaveBeenCalledWith({ type: "agent_start" });
		const eventsBeforeDispose = hooks.onEvent.mock.calls.length;
		await child.dispose();
		currentSession.emit({ type: "agent_start" });
		expect(hooks.onEvent).toHaveBeenCalledTimes(eventsBeforeDispose);
		expect(currentSession.subscribe.mock.results[0].value).toHaveBeenCalledTimes(1);
	});

	it("uses cooperative cancellation and disposes the SDK runtime exactly once", async () => {
		const { child } = await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });
		const runtime = child.runtime as any;

		await child.abort();
		expect(sdk.state.sessions[0].abort).toHaveBeenCalledTimes(1);
		await child.dispose();
		await child.dispose();
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
	});
});
