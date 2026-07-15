import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		savedProjectTrust: boolean | null;
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
		savedProjectTrust: null,
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

		get = vi.fn((_cwd: string): boolean | null => state.savedProjectTrust);
		set = vi.fn((_cwd: string, decision: boolean | null) => {
			state.savedProjectTrust = decision;
		});
	}

	const resolveProjectTrusted = vi.fn(async (options: any): Promise<boolean> => {
		for (const extension of options.extensionsResult?.extensions ?? []) {
			const handlers = extension.handlers?.get?.("project_trust") ?? [];
			for (const handler of handlers) {
				const decision = await handler(
					{ type: "project_trust", cwd: options.cwd },
					options.projectTrustContext,
				);
				if (decision.trusted === "yes" || decision.trusted === "no") {
					if (decision.remember === true) {
						options.trustStore.set(options.cwd, decision.trusted === "yes");
					}
					return decision.trusted === "yes";
				}
			}
		}

		const saved = options.trustStore.get(options.cwd);
		if (saved !== null) return saved;
		if (options.defaultProjectTrust === "always") return true;
		if (options.defaultProjectTrust === "never") return false;
		if (options.projectTrustContext?.hasUI !== false) {
			throw new Error("interactive trust prompt is not allowed for child sessions");
		}
		return false;
	});

	const hasTrustRequiringProjectResources = vi.fn(() => true);

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
		state.savedProjectTrust = null;
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
			resolveProjectTrusted,
			hasTrustRequiringProjectResources,
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
		resolveProjectTrusted,
		hasTrustRequiringProjectResources,
		ProjectTrustStore,
		SettingsManager: { create: vi.fn(() => ({ getDefaultProjectTrust: () => state.defaultProjectTrust })) },
		getAgentDir: vi.fn(() => "/agent-dir"),
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: sdk.SessionManager,
	createEventBus: sdk.createEventBus,
	createAgentSessionServices: sdk.createAgentSessionServices,
	createAgentSessionFromServices: sdk.createAgentSessionFromServices,
	createAgentSessionRuntime: sdk.createAgentSessionRuntime,
	resolveCliModel: sdk.resolveCliModel,
	resolveProjectTrusted: sdk.resolveProjectTrusted,
	hasTrustRequiringProjectResources: sdk.hasTrustRequiringProjectResources,
	ProjectTrustStore: sdk.ProjectTrustStore,
	SettingsManager: sdk.SettingsManager,
	getAgentDir: sdk.getAgentDir,
}));

import {
	createManagedChildSession,
	type ChildSessionConfig,
	type ChildSessionHooks,
	type ManagedChildSession,
	type ManagedChildSessionDependencies,
} from "./managed-child-session.js";

const uplink = {} as MessagePort;
let children: ManagedChildSession[] = [];

function makeConfig(
	target: ChildSessionConfig["target"],
	overrides: Partial<ChildSessionConfig> = {},
): ChildSessionConfig {
	return {
		id: "worker",
		target,
		scope: {
			kind: "child",
			identity: {
				id: "worker",
				task: "inspect the change",
				channels: ["parent"],
				tools: ["respond", "send"],
			},
			uplink,
		},
		modelRef: "provider/model:xhigh",
		allowedTools: ["read", "send"],
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

function makeProjectTrustExtension(
	trusted: "yes" | "no" | "undecided",
	remember?: boolean,
): { handlers: Map<string, Array<(...args: any[]) => unknown>>; handler: ReturnType<typeof vi.fn> } {
	const handler = vi.fn(() => ({
		trusted,
		...(remember === undefined ? {} : { remember }),
	}));
	return {
		handlers: new Map([["project_trust", [handler]]]),
		handler,
	};
}

function projectTrustResolver(): (input: { extensionsResult: any }) => Promise<boolean> {
	const resolver = sdk.state.servicesArgs[0]?.resourceLoaderReloadOptions?.resolveProjectTrust;
	expect(resolver).toEqual(expect.any(Function));
	return resolver;
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
	children = [];
});

afterEach(async () => {
	await Promise.all(children.map((child) => child.dispose()));
});

describe("createManagedChildSession construction", () => {
	it("maps new, resume, and fork targets to their SDK session-manager operations", async () => {
		const fresh = await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });
		expect(sdk.SessionManager.create).toHaveBeenCalledWith("/repo", "/sessions");
		expect(sdk.state.managers[0].appendSessionInfo).toHaveBeenCalledWith("worker");
		expect(fresh.child.sessionId).toBe("new-1");
		expect(fresh.child.sessionFile).toBe("/sessions/new-1.jsonl");

		const resumed = await createChild({
			kind: "resume",
			sessionFile: "/sessions/rpc-created.jsonl",
			sessionDir: "/sessions",
		});
		expect(sdk.SessionManager.open).toHaveBeenCalledWith("/sessions/rpc-created.jsonl", "/sessions");
		expect(sdk.state.servicesArgs[1]).toMatchObject({ cwd: "/resumed-project" });
		expect(resumed.child.sessionFile).toBe("/sessions/rpc-created.jsonl");

		const forked = await createChild({
			kind: "fork",
			sourceSessionFile: "/parent.jsonl",
			cwd: "/fork-project",
			sessionDir: "/sessions",
		});
		expect(sdk.SessionManager.forkFrom).toHaveBeenCalledWith("/parent.jsonl", "/fork-project", "/sessions");
		expect(sdk.state.managers[2].appendSessionInfo).toHaveBeenCalledWith("worker");
		expect(forked.child.sessionFile).toBe("/sessions/fork-3.jsonl");
	});

	it("passes shared SDK infrastructure and independent tool policies into the child runtime", async () => {
		const { dependencies } = await createChild(
			{ kind: "new", cwd: "/repo", sessionDir: "/sessions" },
			{
				allowedTools: ["read", "send"],
				scope: {
					kind: "child",
					identity: {
						id: "worker",
						task: "inspect the change",
						channels: ["parent"],
						tools: ["respond", "send"],
					},
					uplink,
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
			tools: ["read", "send"],
			thinkingLevel: "xhigh",
		});
		expect(sessionOptions.tools).not.toContain("ask_user");

		await createChild(
			{ kind: "new", cwd: "/repo", sessionDir: "/sessions" },
			{ allowedTools: undefined },
		);
		expect(sdk.state.sessionArgs[1].excludeTools).toContain("ask_user");
	});

	it("declines unresolved project trust without opening a child dialog", async () => {
		await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });
		const resolveProjectTrust = sdk.state.servicesArgs[0].resourceLoaderReloadOptions?.resolveProjectTrust;
		expect(resolveProjectTrust).toEqual(expect.any(Function));
		await expect(resolveProjectTrust({ extensionsResult: { extensions: [], errors: [] } })).resolves.toBe(false);

		const bindings = sdk.state.bindings[0].bindings;
		await expect(bindings.uiContext.confirm({ message: "trust this project?" })).resolves.toBe(false);
	});

	it("uses an extension project_trust decision before saved trust and configured defaults", async () => {
		sdk.state.savedProjectTrust = true;
		sdk.state.defaultProjectTrust = "always";
		const extension = makeProjectTrustExtension("no");
		await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });

		await expect(projectTrustResolver()({
			extensionsResult: { extensions: [extension], errors: [] },
		})).resolves.toBe(false);
		expect(extension.handler).toHaveBeenCalledWith(
			{ type: "project_trust", cwd: "/repo" },
			expect.objectContaining({ mode: "rpc", hasUI: false }),
		);
	});

	it("uses saved trust when no extension handler decides, before the configured default", async () => {
		sdk.state.savedProjectTrust = true;
		sdk.state.defaultProjectTrust = "never";
		await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });

		await expect(projectTrustResolver()({
			extensionsResult: { extensions: [], errors: [] },
		})).resolves.toBe(true);
	});

	it("uses the configured default when extension and saved trust are unresolved", async () => {
		sdk.state.savedProjectTrust = null;
		sdk.state.defaultProjectTrust = "always";
		await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });

		await expect(projectTrustResolver()({
			extensionsResult: { extensions: [], errors: [] },
		})).resolves.toBe(true);
	});

	it("declines an unresolved ask default in the child without enabling interactive trust UI", async () => {
		sdk.state.savedProjectTrust = null;
		sdk.state.defaultProjectTrust = "ask";
		await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" });
		const resolveProjectTrust = projectTrustResolver();
		const callsBeforeResolution = sdk.resolveProjectTrusted.mock.calls.length;

		await expect(resolveProjectTrust({
			extensionsResult: { extensions: [], errors: [] },
		})).resolves.toBe(false);
		expect(sdk.resolveProjectTrusted.mock.calls.length).toBeGreaterThan(callsBeforeResolution);
		const trustCall = sdk.resolveProjectTrusted.mock.calls.slice(-1)[0]?.[0];
		expect(trustCall?.projectTrustContext).toMatchObject({ mode: "rpc", hasUI: false });
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

	it("rebinds the same wrapper after session replacement and reports complete metadata", async () => {
		const hooks = makeHooks();
		const { child } = await createChild({ kind: "new", cwd: "/repo", sessionDir: "/sessions" }, {}, hooks);
		const oldSession = child.session as any;

		await child.runtime.newSession();

		expect(child.session).toBe(child.runtime.session);
		expect(child.sessionId).toBe("replacement-2");
		expect(child.sessionFile).toBe("/sessions/replacement-2.jsonl");
		expect(hooks.onSessionChanged).toHaveBeenCalledWith({
			sessionId: "replacement-2",
			sessionFile: "/sessions/replacement-2.jsonl",
			cwd: "/replacement-project",
		});
		expect(oldSession.subscribe.mock.results[0].value).toHaveBeenCalledTimes(1);
		expect(sdk.state.bindings).toHaveLength(2);

		oldSession.emit({ type: "agent_start" });
		expect(hooks.onEvent).not.toHaveBeenCalledWith({ type: "agent_start" });
		(child.session as any).emit({ type: "agent_start" });
		expect(hooks.onEvent).toHaveBeenCalledWith({ type: "agent_start" });
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
