import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CryptoModule from "node:crypto";

const randomness = vi.hoisted(() => ({
	nextId: 0,
	randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(++randomness.nextId).padStart(12, "0")}`),
}));

vi.mock("node:crypto", async (importOriginal) => ({
	...await importOriginal<typeof CryptoModule>(),
	randomUUID: randomness.randomUUID,
}));

const managed = vi.hoisted(() => {
	let sequence = 0;
	const created: { config: any; dependencies: any; hooks: any; child: any }[] = [];
	let onCreate: ((entry: { config: any; dependencies: any; hooks: any; child: any }) => Promise<void>) | undefined;
	const createManagedChildSession = vi.fn(async (config: any, dependencies: any, hooks: any) => {
		const localId = config.path.at(-1);
		const sessionId = `session-${localId}-${++sequence}`;
		const sessionDir = config.target.sessionDir;
		const sessionFile = config.target.kind === "resume"
			? config.target.sessionFile
			: path.join(sessionDir, `100_${sessionId}.jsonl`);
		const session: any = {
			sessionId,
			sessionFile,
			sessionManager: { getCwd: () => config.target.cwd ?? "/restored-cwd" },
		};
		const child: any = {
			runtime: { session },
			eventBus: {},
			session,
			sessionId,
			sessionFile,
			submit: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			dispose: vi.fn(async () => {}),
		};
		const entry = { config, dependencies, hooks, child };
		created.push(entry);
		await onCreate?.(entry);
		return child;
	});
	return {
		created,
		createManagedChildSession,
		setOnCreate(callback: (entry: { config: any; dependencies: any; hooks: any; child: any }) => Promise<void>) {
			onCreate = callback;
		},
		reset() {
			sequence = 0;
			created.length = 0;
			onCreate = undefined;
			createManagedChildSession.mockClear();
		},
	};
});

vi.mock("./managed-child-session.js", () => ({
	createManagedChildSession: managed.createManagedChildSession,
}));

vi.mock("./rpc-child.js", () => ({
	RpcChild: class {
		constructor() {
			throw new Error("the in-process extension must not create RpcChild instances");
		}
	},
}));

vi.mock("./broker.js", () => ({
	Broker: class {
		constructor() {
			throw new Error("the in-process extension must not create socket brokers");
		}
	},
}));

import { createSubagentsExtension } from './scoped-extension.js';
import type { SubagentScope } from './scoped-extension.js';
import { SUBAGENT_PROVIDER_REQUEST, SUBAGENT_PROVIDER_RESPONSE } from "@pimote/sdk/subagents";
import type { SubagentRuntimeRef, SubagentTopologyEvent } from "@pimote/sdk/subagents";
import { serializeAgentMessage } from "./messages.js";
import { SubagentControlPort } from "./control-port.js";
import { RunningToolProgress } from "./tool-progress.js";
import type { SubagentTreeServices } from "./tree-services.js";
// vi.spyOn replaces a method on the module namespace object.
// oxlint-disable-next-line import/no-namespace
import * as agentDiscovery from "./agents.js";
import type { AgentPath } from "./agent-path.js";
import { appendAgentAdded, ensurePersistence } from "./persistence.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import type { AgentNodeSnapshot, RegistryEvent } from "./agent-session-registry.js";
import type { MessagePort, RoutedMessage, SendReceipt } from "./message-router.js";
import type { JsonValue } from "@earendil-works/pi-ai";

const key = (agentPath: AgentPath): string => JSON.stringify(agentPath);

function makeServices(): SubagentTreeServices {
	return { control: new SubagentControlPort(), toolProgress: new RunningToolProgress(), trackRestore: vi.fn() };
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

/** Minimal live-registry fixture for recursive manager integration. */
function makeRegistryFake(ownerPath: AgentPath = [], services: SubagentTreeServices = makeServices()): AgentSessionRegistry {
	const nodes = new Map<string, any>();
	const listeners = new Set<(event: RegistryEvent) => void>();
	const livePaths = new Set<string>([key([])]);
	const publish = (event: RegistryEvent) => {
		for (const listener of listeners) {listener(event);}
	};
	const rootSnapshot: AgentNodeSnapshot = {
		path: [],
		parentPath: null,
		localId: null,
		ownership: "external",
		incarnation: "root",
		sessionId: "root-session",
		cwd: "/repo",
		channels: [],
		operational: {
			state: "idle",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			lastTurnInput: 0,
			hasSubgroup: false,
			pendingCorrelations: [],
			waitingFor: [],
		},
	};
	nodes.set(key([]), { snapshot: rootSnapshot });
	const seedPath = (agentPath: AgentPath) => {
		for (let length = 1; length <= agentPath.length; length++) {
			const pathAtDepth = agentPath.slice(0, length);
			if (nodes.has(key(pathAtDepth))) {continue;}
			const snapshot: AgentNodeSnapshot = {
				path: pathAtDepth,
				parentPath: pathAtDepth.slice(0, -1),
				localId: pathAtDepth.at(-1) ?? null,
				ownership: "registry",
				incarnation: `seed-${pathAtDepth.join("-")}`,
				sessionId: `seed-${pathAtDepth.join("-")}`,
				cwd: "/repo",
				channels: ["parent"],
				operational: {
					state: "idle",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					lastTurnInput: 0,
					hasSubgroup: false,
					pendingCorrelations: [],
					waitingFor: [],
				},
			};
			nodes.set(key(pathAtDepth), {
				snapshot,
				session: { dispose: vi.fn(async () => {}) },
			});
			livePaths.add(key(pathAtDepth));
		}
	};
	seedPath(ownerPath);

	const registry: any = {
		get: vi.fn((agentPath: AgentPath) => nodes.get(key(agentPath))),
		getSnapshot: vi.fn((agentPath: AgentPath) => nodes.get(key(agentPath))?.snapshot),
		waitForLiveNode: async (agentPath: AgentPath) => livePaths.has(key(agentPath)),
		listChildren: vi.fn((parentPath: AgentPath) => nodes.values()
			.filter((node) => node.snapshot.parentPath !== null && key(node.snapshot.parentPath) === key(parentPath))
			.map((node) => node.snapshot)
			.toArray()),
		listDescendants: vi.fn((parentPath: AgentPath) => nodes.values()
			.filter((node) => node.snapshot.path.length > parentPath.length
				&& parentPath.every((segment: string, index: number) => segment === node.snapshot.path[index]))
			.map((node) => node.snapshot)
			.toArray()),
		createChildren: vi.fn(async (parentPath: AgentPath, requests: any[]) => {
			if (!livePaths.has(key(parentPath))) {
				throw new Error(`Unknown parent path: ${key(parentPath)}`);
			}
			const requestedPaths = new Set<string>();
			for (const request of requests) {
				const childPath = [...parentPath, request.localId];
				const childKey = key(childPath);
				if (request.localId === "parent" || nodes.has(childKey) || requestedPaths.has(childKey)) {
					throw new Error(`Duplicate or reserved child path: ${childKey}`);
				}
				requestedPaths.add(childKey);
			}

			const createdNodes: any[] = [];
			for (const request of requests) {
				const childPath = [...parentPath, request.localId];
				// oxlint-disable-next-line prefer-const
				let node: any;
				const childHooks = {
					onEvent: (event: any) => request.hooks.onEvent(event),
					onDiagnostic: (message: string, type?: "info" | "warning" | "error") => request.hooks.onDiagnostic(message, type),
					onSessionChanged: (metadata: any) => {
						if (node) {
							const previous = node.snapshot;
							node.snapshot = { ...previous, ...metadata };
							publish({ type: "node_updated", previous, node: node.snapshot });
						}
						request.hooks.onSessionChanged(metadata);
					},
					onShutdownRequested: () => request.hooks.onShutdownRequested(),
				};
				const config = {
					...request.session,
					path: childPath,
					scope: {
						kind: "child",
						registry,
						path: childPath,
						identity: {
							id: request.localId,
							task: request.task,
							channels: request.channels,
						},
						uplink: request.session.uplink,
						services,
					},
				};
				const session = await managed.createManagedChildSession(config, { agentDir: "/agent" }, childHooks);
				const target = request.session.target;
				const snapshot: AgentNodeSnapshot = {
					path: childPath,
					parentPath: [...parentPath],
					localId: request.localId,
					ownership: "registry",
					incarnation: `incarnation-${request.localId}-${session.sessionId}`,
					sessionId: session.sessionId,
					sessionFile: session.sessionFile,
					cwd: target.kind === "new" || target.kind === "fork" ? target.cwd : "/restored-cwd",
					task: request.task,
					agentDef: request.agentDef,
					channels: request.channels,
					operational: request.initialOperational,
				};
				node = { snapshot, session };
				nodes.set(key(childPath), node);
				livePaths.add(key(childPath));
				createdNodes.push(node);
				publish({ type: "node_added", node: snapshot });
			}
			return createdNodes;
		}),
		updateOperational: vi.fn((agentPath: AgentPath, operational: any) => {
			const node = nodes.get(key(agentPath));
			if (!node) {return;}
			const previous = node.snapshot;
			node.snapshot = { ...previous, operational };
			publish({ type: "node_updated", previous, node: node.snapshot });
		}),
		remove: vi.fn(async (agentPath: AgentPath) => {
			for (const [nodeKey, node] of nodes) {
				if (node.snapshot.ownership === "registry" && (nodeKey === key(agentPath) || nodeKey.startsWith(`${key(agentPath).slice(0, -1)},`))) {
					await node.session.dispose();
					nodes.delete(nodeKey);
					livePaths.delete(nodeKey);
					publish({ type: "node_removed", node: node.snapshot });
				}
			}
		}),
		subscribe: vi.fn((listener: (event: RegistryEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		dispose: vi.fn(async () => {
			for (const node of nodes.values()) {
				if (node.snapshot.ownership === "registry") {await node.session.dispose();}
			}
			nodes.clear();
			nodes.set(key([]), { snapshot: rootSnapshot });
			livePaths.clear();
			livePaths.add(key([]));
		}),
	};
	return registry;
}

const registry = makeRegistryFake();

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: ((update: any) => void) | undefined, ctx: any) => Promise<any>;
};

function makePort(id: string): MessagePort & { emit(message: RoutedMessage): void; listeners: Set<(message: RoutedMessage) => void> } {
	const listeners = new Set<(message: RoutedMessage) => void>();
	const port = {
		id,
		send: vi.fn(async (): Promise<SendReceipt> => ({})),
		respond: vi.fn(async () => {}),
		responseProgress: vi.fn(),
		reject: vi.fn(async () => {}),
		detach: vi.fn(),
		cancel: vi.fn(),
		subscribe: vi.fn((listener: (message: RoutedMessage) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		emit(message: RoutedMessage) {
			for (const listener of listeners) {listener(message);}
		},
		listeners,
	};
	return port;
}

function makePi(options: { activeTools?: string[]; registeredTools?: any[] } = {}) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	let activeTools = options.activeTools ?? [
		"list_models", "subagent", "fork", "send", "respond", "check_status",
		"teardown", "resurrect", "await_agents", "interrupt",
	];
	const registeredTools = options.registeredTools ?? [];
	const pi = {
		registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
		getCommands: vi.fn(() => []),
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => registeredTools),
		setActiveTools: vi.fn((names: string[]) => { activeTools = names; }),
		getThinkingLevel: vi.fn(() => "medium"),
		sendMessage: vi.fn((message: { customType: string; details?: unknown }) => committedEntries.push({ type: "custom_message", ...message })),
		appendEntry: vi.fn(),
	};
	return { pi, tools, handlers, commands };
}

/** The parent session's committed branch. */
const committedEntries: (
	| { type: "custom_message"; customType: string; details?: unknown }
	| { type: "message"; message: { role: "toolResult"; toolName: string; isError: boolean; details?: unknown } }
)[] = [];

function makeContext(parentSessionFile: string, overrides: Record<string, JsonValue> = {}) {
	return {
		cwd: path.dirname(parentSessionFile),
		mode: "tui",
		hasUI: true,
		ui: {
			notify: vi.fn(),
			setWidget: vi.fn(),
			setStatus: vi.fn(),
			setTitle: vi.fn(),
			confirm: vi.fn(async () => false),
			select: vi.fn(async () => undefined),
			input: vi.fn(async () => undefined),
		},
		sessionManager: {
			getSessionFile: () => parentSessionFile,
			getSessionId: () => "root-session",
			getSessionName: () => "parent",
			getLeafId: (): string | null => null,
			getBranch: () => committedEntries,
		},
		modelRegistry: {
			getAvailable: vi.fn(() => [{
				provider: "provider",
				id: "model",
				contextWindow: 200_000,
				cost: { input: 1, output: 2, cacheRead: 0.25 },
			}]),
		},
		model: { id: "model" },
		isProjectTrusted: () => true,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		compact: vi.fn(),
		getSystemPrompt: () => "",
		...overrides,
	};
}

async function execute(tools: Map<string, RegisteredTool>, name: string, params: unknown, ctx: unknown) {
	const tool = tools.get(name);
	if (!tool) {throw new Error(`Tool ${name} was not registered`);}
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

function runTool(
	tools: Map<string, RegisteredTool>,
	name: string,
	params: unknown,
	ctx: unknown,
	options: { toolCallId?: string; signal?: AbortSignal } = {},
) {
	const tool = tools.get(name);
	if (!tool) {throw new Error(`Tool ${name} was not registered`);}
	const updates: any[] = [];
	const result: Promise<any> = tool.execute(options.toolCallId ?? "call-1", params, options.signal, (update) => updates.push(update), ctx);
	return { result, updates };
}

async function startSession(handlers: Map<string, (...args: any[]) => any>, ctx: unknown): Promise<void> {
	await handlers.get("session_start")?.({ reason: "new" }, ctx);
	await new Promise((resolve) => { setTimeout(resolve, 0); });
}

let tmpRoot: string | undefined;

beforeEach(() => {
	committedEntries.length = 0;
	randomness.nextId = 0;
	managed.reset();
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-subagents-test-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	if (tmpRoot) {fs.rmSync(tmpRoot, { recursive: true, force: true });}
	tmpRoot = undefined;
});

describe("child-scoped extension routing", () => {
	it("waits for session_start initialization before running a tool", async () => {
		let releaseDiscovery!: () => void;
		const discoveryGate = new Promise<void>((resolve) => {
			releaseDiscovery = resolve;
		});
		const discovery = vi.spyOn(agentDiscovery, "discoverPackageAgents").mockImplementation(async () => {
			await discoveryGate;
			return { user: [], project: [] };
		});
		try {
			const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
			fs.writeFileSync(parentSessionFile, "");
			const { pi, tools, handlers } = makePi();
			await createSubagentsExtension({ kind: "root" })(pi as any);
			const ctx = makeContext(parentSessionFile);
			const promptEvent = { systemPrompt: "base", systemPromptOptions: { sections: {} } };
			const promptPreparation = handlers.get("before_agent_start")?.(promptEvent, ctx);
			const starting = handlers.get("session_start")?.({ reason: "new" }, ctx);
			await vi.waitFor(() => expect(discovery).toHaveBeenCalled());

			let settled = false;
			const listing = execute(tools, "list_models", {}, ctx).finally(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			releaseDiscovery();
			await starting;
			await promptPreparation;
			expect(promptEvent.systemPromptOptions.sections["subagents"]).toContain("Model Tiers");
			await expect(listing).resolves.toMatchObject({ content: [{ type: "text" }] });
		} finally {
			discovery.mockRestore();
		}
	});

	it("routes child sends and responses through its explicit uplink, not process globals", async () => {
		const uplink = makePort("child");
		const scope: SubagentScope = {
			kind: "child",
			registry,
			path: ["child"],
			identity: {
				id: "child",
				task: "work",
				channels: ["parent"],
			},
			uplink,
			services: makeServices(),
		};
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension(scope)(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
		await startSession(handlers, ctx);

		await execute(tools, "send", { to: "parent", message: "hello", expectResponse: false }, ctx);
		expect(uplink.send).toHaveBeenCalledWith(expect.objectContaining({
			to: "parent",
			message: "hello",
			expectResponse: false,
		}));

		uplink.emit({
			from: "parent",
			message: "please answer",
			correlationId: "corr-parent",
			responseExpected: true,
		});
		await execute(tools, "respond", { correlationId: "corr-parent", message: "answer" }, ctx);
		expect(uplink.respond).toHaveBeenCalledWith("corr-parent", "answer");
		await expect(execute(tools, "respond", { correlationId: "corr-missing", message: "answer" }, ctx))
			.rejects.toThrow(/origin|route|recorded/i);
		expect(uplink.respond).not.toHaveBeenCalledWith("corr-missing", "answer");
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("<agent_message"),
			}),
			{ triggerTurn: true },
		);
	});

	it("records the sibling a child's uplink send reached as the card's target", async () => {
		const uplink = makePort("worker");
		const scope: SubagentScope = {
			kind: "child",
			registry,
			path: ["worker"],
			identity: { id: "worker", task: "work", channels: ["scout", "parent"] },
			uplink,
			services: makeServices(),
		};
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension(scope)(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
		await startSession(handlers, ctx);

		const result = await execute(tools, "send", { to: "scout", message: "hello", expectResponse: false }, ctx);
		expect(result.details.subagent.data.parameters).toEqual({ to: "scout", target: ["scout"], message: "hello", expectResponse: false });
	});

	it("removes model-only tools from a child before its model request", async () => {
		const uplink = makePort("child");
		const { pi, handlers } = makePi({
			activeTools: ["read", "ask_user", "user_edit", "subagent", "respond"],
			registeredTools: [
				{ name: "read", exposure: "direct" },
				{ name: "ask_user", exposure: "model-only" },
				{ name: "user_edit", exposure: "model-only" },
				{ name: "subagent", exposure: "direct" },
				{ name: "respond", exposure: "direct" },
			],
		});
		await createSubagentsExtension({
			kind: "child",
			registry,
			path: ["child"],
			identity: { id: "child", task: "work", channels: ["parent"] },
			uplink,
			services: makeServices(),
		})(pi as any);
		const parentSessionFile = path.join(tmpRoot!, "child.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const ctx = makeContext(parentSessionFile, { mode: "print", hasUI: false });
		await startSession(handlers, ctx);
		await handlers.get("before_agent_start")?.({ systemPromptOptions: { sections: {} } }, ctx);

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "subagent", "respond"]);
		expect(pi.getActiveTools()).toEqual(["read", "subagent", "respond"]);
		expect(await handlers.get("tool_call")?.({ toolName: "user_edit" }, ctx)).toEqual({
			block: true,
			reason: "Model-only tools are unavailable in sessions without UI.",
		});
	});

	it("keeps model-only tools available when the session has UI", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, handlers } = makePi({
			activeTools: ["ask_user", "user_edit", "subagent"],
			registeredTools: [
				{ name: "ask_user", exposure: "model-only" },
				{ name: "user_edit", exposure: "model-only" },
				{ name: "subagent", exposure: "direct" },
			],
		});
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);
		await handlers.get("before_agent_start")?.({ systemPromptOptions: { sections: {} } }, ctx);

		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(pi.getActiveTools()).toEqual(["ask_user", "user_edit", "subagent"]);
		expect(await handlers.get("tool_call")?.({ toolName: "ask_user" }, ctx)).toBeUndefined();
	});

	it("starts a turn when an idle child receives a routed message", async () => {
		const uplink = makePort("child");
		const { pi, handlers } = makePi();
		await createSubagentsExtension({
			kind: "child",
			registry,
			path: ["child"],
			identity: { id: "child", task: "work", channels: ["parent"] },
			uplink,
			services: makeServices(),
		})(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
		await startSession(handlers, ctx);

		uplink.emit({ from: "parent", message: "continue", responseExpected: false });
		await tick();

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagents",
				content: expect.stringContaining("continue"),
				display: true,
				details: expect.objectContaining({ subagent: [expect.objectContaining({
					kind: "message_received",
					data: expect.objectContaining({ parameters: { from: [], message: "continue", expectResponse: false } }),
				})] }),
			}),
			{ triggerTurn: true },
		);
	});

	it("keeps child notifications local after session shutdown and renders the scoped model catalog", async () => {
		const uplink = makePort("child");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({
			kind: "child",
			registry,
			path: ["child"],
			identity: {
				id: "child",
				task: "work",
				channels: ["parent"],
			},
			uplink,
			services: makeServices(),
		})(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
		await startSession(handlers, ctx);

		const models = await execute(tools, "list_models", {}, ctx);
		expect(models.content[0].text).toContain("provider/model");
		expect(models.content[0].text).toContain("200000");
		expect(models.content[0].text).toContain("1.00");

		await handlers.get("session_shutdown")?.({}, ctx);
		await expect(execute(tools, "send", { to: "parent", message: "too late", expectResponse: false }, ctx))
			.rejects.toThrow(/shutting down/i);
		uplink.emit({ from: "parent", message: "after shutdown", responseExpected: false });
		await tick();
		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("after shutdown"),
			}),
			{ triggerTurn: true },
		);
	});

	it("uses the supplied child registry and path when recursively spawning a grandchild", async () => {
		const childRegistry = makeRegistryFake(["researcher", "worker"]);
		const parentUplink = makePort("worker-uplink");
		const parentSessionFile = path.join(tmpRoot!, "worker.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({
			kind: "child",
			registry: childRegistry,
			path: ["researcher", "worker"],
			identity: { id: "worker", task: "delegate", channels: ["parent"] },
			uplink: parentUplink,
			services: makeServices(),
		})(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "scout", task: "inspect", channels: [] }],
		}, ctx);

		const grandchildPath = ["researcher", "worker", "scout"];
		expect((childRegistry.createChildren as any)).toHaveBeenCalledWith(
			["researcher", "worker"],
			[expect.objectContaining({
				localId: "scout",
				task: "inspect",
				hooks: expect.objectContaining({
					onEvent: expect.any(Function),
					onDiagnostic: expect.any(Function),
					onSessionChanged: expect.any(Function),
					onShutdownRequested: expect.any(Function),
				}),
			})],
		);
		expect(managed.createManagedChildSession).toHaveBeenCalledTimes(1);
		expect(managed.created[0].config).toMatchObject({
			path: grandchildPath,
			scope: {
				registry: childRegistry,
				path: grandchildPath,
				identity: { id: "scout" },
			},
		});
		expect(childRegistry.getSnapshot(grandchildPath)).toMatchObject({
			path: grandchildPath,
			parentPath: ["researcher", "worker"],
			localId: "scout",
		});
		expect(childRegistry.listChildren(["researcher", "worker"])).toEqual([
			expect.objectContaining({ path: grandchildPath }),
		]);
		const recursiveRequest = (childRegistry.createChildren as any).mock.calls[0][1][0];
		const managerSessionChanged = vi.spyOn(recursiveRequest.hooks, "onSessionChanged");
		const replacement = {
			sessionId: "replacement-scout",
			sessionFile: "/sessions/replacement-scout.jsonl",
			cwd: "/replacement-project",
		};
		managed.created[0].hooks.onSessionChanged(replacement);
		expect(managerSessionChanged).toHaveBeenCalledWith(replacement);
		expect(childRegistry.getSnapshot(grandchildPath)).toMatchObject(replacement);
		expect(managed.created[0].config.scope.uplink).not.toBe(parentUplink);
	});

	it("responds through the exact local origin when a correlation collides with the uplink", async () => {
		const childRegistry = makeRegistryFake(["researcher", "worker"]);
		const parentUplink = makePort("worker-uplink");
		const parentSessionFile = path.join(tmpRoot!, "worker.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({
			kind: "child",
			registry: childRegistry,
			path: ["researcher", "worker"],
			identity: { id: "worker", task: "delegate", channels: ["parent"] },
			uplink: parentUplink,
			services: makeServices(),
		})(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);
		await execute(tools, "subagent", { agents: [{ id: "scout", task: "ask", channels: [] }] }, ctx);

		const localPort: MessagePort = managed.created[0].config.scope.uplink;
		const pending = await localPort.send({
			to: "parent",
			message: "local question",
			expectResponse: true,
			correlationId: "corr-collision",
		});
		parentUplink.emit({
			from: "parent",
			message: "uplink collision",
			responseExpected: true,
			correlationId: "corr-collision",
		});
		await execute(tools, "respond", { correlationId: "corr-collision", message: "local answer" }, ctx);

		await expect(pending.response).resolves.toEqual({ type: "response", message: "local answer" });
		expect(parentUplink.reject).toHaveBeenCalledWith("corr-collision", expect.stringContaining("already pending"));
		expect(parentUplink.respond).not.toHaveBeenCalled();
	});

	it("uses explicit child scope rather than a conflicting process-wide parent link", async () => {
		const previous = process.env.PI_PARENT_LINK;
		process.env.PI_PARENT_LINK = JSON.stringify({ id: "wrong-child", brokerSocket: "/tmp/stale.sock" });
		try {
			const uplink = makePort("explicit-child");
			const { pi, tools, handlers } = makePi();
			await createSubagentsExtension({
				kind: "child",
				registry,
				path: ["explicit-child"],
				identity: { id: "explicit-child", task: "work", channels: ["parent"] },
				uplink,
				services: makeServices(),
			})(pi as any);
			const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
			await startSession(handlers, ctx);

			await execute(tools, "send", { to: "parent", message: "scope wins", expectResponse: false }, ctx);
			expect(uplink.send).toHaveBeenCalledWith(expect.objectContaining({
				to: "parent",
				message: "scope wins",
				expectResponse: false,
			}));
		} finally {
			if (previous === undefined) {delete process.env.PI_PARENT_LINK;}
			else {process.env.PI_PARENT_LINK = previous;}
		}
	});

	it("parks notifications without a turn when the run was aborted", async () => {
		const uplink = makePort("child");
		const scope: SubagentScope = {
			kind: "child",
			registry,
			path: ["child"],
			identity: { id: "child", task: "work", channels: ["parent"] },
			uplink,
			services: makeServices(),
		};
		const { pi, handlers } = makePi();
		await createSubagentsExtension(scope)(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
		await startSession(handlers, ctx);
		const aborting = { ...ctx, signal: { aborted: true } };

		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await handlers.get("tool_execution_start")?.({ toolCallId: "t1", toolName: "bash" }, ctx);
		uplink.emit({ from: "parent", message: "stop that", responseExpected: false });
		await tick();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(handlers.get("turn_end")?.({ type: "turn_end", outcome: "aborted" }, aborting)).toBeUndefined();
		expect(pi.sendMessage).not.toHaveBeenCalled();

		await handlers.get("agent_end")?.({
			type: "agent_end",
			willRetry: false,
			messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
		}, aborting);
		await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: true }, ctx);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("stop that") }),
			{ triggerTurn: false },
		);
	});

	it("still wakes the agent with queued notifications after a normal run ends", async () => {
		const uplink = makePort("child");
		const scope: SubagentScope = {
			kind: "child",
			registry,
			path: ["child"],
			identity: { id: "child", task: "work", channels: ["parent"] },
			uplink,
			services: makeServices(),
		};
		const { pi, handlers } = makePi();
		await createSubagentsExtension(scope)(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
		await startSession(handlers, ctx);

		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await handlers.get("tool_execution_start")?.({ toolCallId: "t1", toolName: "bash" }, ctx);
		uplink.emit({ from: "parent", message: "more work", responseExpected: false });
		await handlers.get("agent_end")?.({
			type: "agent_end",
			willRetry: false,
			messages: [{ role: "assistant", stopReason: "stop", content: [] }],
		}, ctx);
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("more work") }),
			{ triggerTurn: true },
		);
	});

	it("keeps uplink listeners and mutable child scope state isolated", async () => {
		const firstUplink = makePort("first");
		const secondUplink = makePort("second");
		const first = makePi();
		const second = makePi();
		const firstScope: SubagentScope = {
			kind: "child", registry, path: ["first"],
			identity: { id: "first", task: "one", channels: ["parent"] }, uplink: firstUplink, services: makeServices(),
		};
		const secondScope: SubagentScope = {
			kind: "child", registry, path: ["second"],
			identity: { id: "second", task: "two", channels: ["parent"] }, uplink: secondUplink, services: makeServices(),
		};
		await createSubagentsExtension(firstScope)(first.pi as any);
		await createSubagentsExtension(secondScope)(second.pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));
		await startSession(first.handlers, ctx);
		await startSession(second.handlers, ctx);

		await execute(first.tools, "send", { to: "parent", message: "from first", expectResponse: false }, ctx);
		await execute(second.tools, "send", { to: "parent", message: "from second", expectResponse: false }, ctx);
		firstUplink.emit({ from: "parent", message: "only first", responseExpected: false });
		await tick();

		expect(firstUplink.send).toHaveBeenCalledTimes(1);
		expect(secondUplink.send).toHaveBeenCalledTimes(1);
		expect(first.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("only first") }),
			{ triggerTurn: true },
		);
		expect(second.pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("only first") }),
			{ triggerTurn: true },
		);
	});
});

function makeEventBus() {
	const listeners = new Map<string, Set<(data: any) => void>>();
	const responses: { provider: any }[] = [];
	const topology: SubagentTopologyEvent[] = [];
	const watched = new Set<unknown>();
	return {
		responses,
		topology,
		on(name: string, listener: (data: any) => void) {
			const group = listeners.get(name) ?? new Set();
			group.add(listener);
			listeners.set(name, group);
			return () => group.delete(listener);
		},
		emit(name: string, data: any) {
			if (name === SUBAGENT_PROVIDER_RESPONSE) {
				responses.push(data);
				if (data.provider && !watched.has(data.provider)) {
					watched.add(data.provider);
					data.provider.subscribe((event: SubagentTopologyEvent) => topology.push(event));
				}
			}
			for (const listener of listeners.get(name) ?? []) {listener(data);}
		},
	};
}

async function rootSession() {
	const sessionFile = path.join(tmpRoot!, "root.jsonl");
	fs.writeFileSync(sessionFile, "");
	const root = makePi();
	const bus = makeEventBus();
	(root.pi as any).events = bus;
	await createSubagentsExtension({ kind: "root" })(root.pi as any);
	const ctx = makeContext(sessionFile);
	await startSession(root.handlers, ctx);
	await execute(root.tools, "subagent", { agents: [{ id: "worker", task: "inspect", channels: [] }] }, ctx);
	const provider = bus.responses.at(-1)?.provider;
	const ref = (localId: string): SubagentRuntimeRef => {
		const node = provider.snapshot().nodes.find((candidate: any) => key(candidate.path) === key([localId]));
		return { path: node.path, incarnation: node.incarnation };
	};
	return { ...root, ctx, bus, provider, ref, worker: managed.created[0] };
}

function settleChild(entry: { hooks: any }, output: string, error?: string): void {
	entry.hooks.onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }] } });
	entry.hooks.onEvent({
		type: "agent_end",
		willRetry: false,
		messages: error ? [{ role: "assistant", stopReason: "error", errorMessage: error }] : [],
	});
	entry.hooks.onEvent({ type: "agent_settled" });
}

function subagentNotices(pi: ReturnType<typeof makePi>["pi"]): [any, any][] {
	return pi.sendMessage.mock.calls.filter(([message]) => message.customType === "subagents") as [any, any][];
}

function noticesContaining(pi: ReturnType<typeof makePi>["pi"], text: string): [any, any][] {
	return subagentNotices(pi).filter(([message]) => message.content.includes(text));
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
	let settled = false;
	void promise.then(() => { settled = true; }, () => { settled = true; });
	await tick();
	expect(settled).toBe(false);
}

describe("parent notices", () => {
	it("delivers a child completion to an idle parent as one turn-starting notice with a completion card", async () => {
		const root = await rootSession();
		root.pi.sendMessage.mockClear();
		settleChild(root.worker, "saved answer");
		await tick();

		const notices = subagentNotices(root.pi);
		expect(notices).toHaveLength(1);
		const [message, options] = notices[0];
		expect(options).toEqual({ triggerTurn: true });
		expect(message.content).toContain("<agent_idle");
		expect(message.content).toContain("saved answer");
		expect(message.details.subagent).toEqual([expect.objectContaining({
			kind: "completion",
			state: "complete",
			data: expect.objectContaining({ result: expect.objectContaining({ path: ["worker"], output: "saved answer" }) }),
		})]);
	});

	it("batches notices that arrive together into one message with one card each", async () => {
		const root = await rootSession();
		await execute(root.tools, "subagent", { agents: [{ id: "scout", task: "look", channels: [] }] }, root.ctx);
		root.pi.sendMessage.mockClear();
		settleChild(root.worker, "worker answer");
		settleChild(managed.created[1], "scout answer");
		await tick();

		const notices = subagentNotices(root.pi);
		expect(notices).toHaveLength(1);
		expect(notices[0][0].content).toContain("worker answer");
		expect(notices[0][0].content).toContain("scout answer");
		expect(notices[0][0].details.subagent.map((card: any) => card.data.result.path)).toEqual([["worker"], ["scout"]]);
	});

	it("adds notices to a running parent turn at the next boundary without starting a turn", async () => {
		const root = await rootSession();
		await root.handlers.get("agent_start")?.({ type: "agent_start" }, root.ctx);
		root.pi.sendMessage.mockClear();
		settleChild(root.worker, "mid-run answer");
		await tick();
		expect(subagentNotices(root.pi)).toEqual([]);

		expect(root.handlers.get("turn_end")?.({ type: "turn_end", outcome: "continue" }, root.ctx)).toEqual({ continue: true });
		expect(noticesContaining(root.pi, "mid-run answer")).toEqual([[expect.anything(), { triggerTurn: false }]]);
		expect(root.handlers.get("agent_before_settle")?.({ type: "agent_before_settle", outcome: "continue" }, root.ctx)).toBeUndefined();
	});

	it("delivers a completion while a view holds a lease on the child", async () => {
		const root = await rootSession();
		const lease = await root.provider.acquire(root.ref("worker"));
		root.pi.sendMessage.mockClear();
		settleChild(root.worker, "viewed answer");
		await tick();

		expect(noticesContaining(root.pi, "viewed answer")).toHaveLength(1);
		lease.release();
	});

	it("parks a completion an aborted wait did not deliver until the parent stops", async () => {
		const root = await rootSession();
		await execute(root.tools, "subagent", { agents: [{ id: "scout", task: "look", channels: [] }] }, root.ctx);
		await root.handlers.get("agent_start")?.({ type: "agent_start" }, root.ctx);
		root.pi.sendMessage.mockClear();
		const controller = new AbortController();
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker", "scout"] }, root.ctx, { signal: controller.signal });
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		settleChild(root.worker, "unread answer");
		controller.abort();

		await expect(waiting.result).rejects.toThrow("Wait cancelled.");
		await tick();
		expect(noticesContaining(root.pi, "unread answer")).toEqual([]);
		await root.handlers.get("agent_end")?.({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "aborted", content: [] }] }, root.ctx);
		await root.handlers.get("agent_settled")?.({ type: "agent_settled", aborted: true }, root.ctx);
		expect(noticesContaining(root.pi, "unread answer")).toEqual([[expect.objectContaining({ content: expect.stringContaining("<agent_idle") }), { triggerTurn: false }]]);
	});

	it("tells the parent about a user teardown as context without a turn", async () => {
		const root = await rootSession();
		const worker = root.provider.snapshot().nodes.find((node: any) => key(node.path) === key(["worker"]));
		root.pi.sendMessage.mockClear();
		await expect(root.provider.teardown(root.ref("worker"))).resolves.toMatchObject({ removed: true, sessionId: worker.sessionId });

		const notices = subagentNotices(root.pi);
		expect(notices).toHaveLength(1);
		const [message, options] = notices[0];
		expect(options).toEqual({ triggerTurn: false });
		expect(message.content).toContain("<agent_removed");
		expect(message.content).toContain("worker");
		expect(message.details.subagent).toEqual([expect.objectContaining({
			kind: "teardown",
			data: expect.objectContaining({
				parameters: expect.objectContaining({ source: "user" }),
				result: { affectedAgents: [expect.objectContaining({ path: ["worker"], sessionId: worker.sessionId, task: "inspect" })] },
			}),
		})]);
	});

	it("tells the parent about a user resurrection as context without a turn", async () => {
		const root = await rootSession();
		const first = root.worker.child;
		fs.mkdirSync(path.dirname(first.sessionFile), { recursive: true });
		fs.writeFileSync(first.sessionFile, "");
		await execute(root.tools, "teardown", { agent: "worker" }, root.ctx);
		root.pi.sendMessage.mockClear();

		const result = await root.provider.resurrect({ parentPath: [], localId: "restored", sessionId: first.sessionId, task: "continue", channels: [] });

		expect(result).toMatchObject({ path: ["restored"], sessionId: managed.created[1].child.sessionId });
		const notices = subagentNotices(root.pi);
		expect(notices).toHaveLength(1);
		const [message, options] = notices[0];
		expect(options).toEqual({ triggerTurn: false });
		expect(message.content).toContain("<agent_resurrected");
		expect(message.content).toContain(`session_id="${result.sessionId}"`);
		expect(message.details.subagent).toEqual([expect.objectContaining({
			kind: "resurrect",
			data: expect.objectContaining({
				parameters: expect.objectContaining({ source: "user" }),
				result: { affectedAgents: [expect.objectContaining({ path: ["restored"], sessionId: first.sessionId })] },
			}),
		})]);
	});

	it("delivers child messages to a resumed child session", async () => {
		const childRegistry = makeRegistryFake(["worker"]);
		const ctx = makeContext(path.join(tmpRoot!, "child.jsonl"));
		for (const reason of ["new", "resume", "reload"]) {
			const child = makePi();
			const uplink = makePort("worker");
			await createSubagentsExtension({
				kind: "child", registry: childRegistry, path: ["worker"],
				identity: { id: "worker", task: "inspect", channels: ["parent"] }, uplink, services: makeServices(),
			})(child.pi as any);
			await child.handlers.get("session_start")?.({ reason }, ctx);
			uplink.emit({ from: "parent", message: reason, responseExpected: false });
			await tick();
			const notification = child.pi.sendMessage.mock.calls.at(-1)?.[0];
			expect(notification).toMatchObject({
				customType: "subagents",
				content: serializeAgentMessage({ from: "parent", content: reason, responseExpected: false }),
				details: { subagent: [expect.objectContaining({ kind: "message_received", data: expect.objectContaining({ parameters: expect.objectContaining({ from: [], message: reason }) }) })] },
			});
			await child.handlers.get("session_shutdown")?.({}, ctx);
		}
	});

	it("keeps message bodies verbatim in both directions", async () => {
		const root = await rootSession();
		const child = makePi();
		await createSubagentsExtension(root.worker.config.scope)(child.pi as any);
		const ctx = makeContext(root.worker.child.sessionFile);
		await startSession(child.handlers, ctx);
		const body = "<raw> & **body**\nnext";
		await execute(child.tools, "send", { to: "parent", message: body, expectResponse: false }, ctx);
		await execute(root.tools, "send", { to: "worker", message: body, expectResponse: false }, root.ctx);
		await tick();

		for (const [pi, from, fromPath] of [[root.pi, "worker", ["worker"]], [child.pi, "parent", []]] as const) {
			const notification = pi.sendMessage.mock.calls.at(-1)?.[0];
			expect(notification.content).toBe(serializeAgentMessage({ from, content: body, responseExpected: false }));
			expect(notification.details.subagent).toEqual([expect.objectContaining({
				kind: "message_received",
				data: expect.objectContaining({ parameters: expect.objectContaining({ from: fromPath, message: body }) }),
			})]);
		}
	});
});

describe("explicit hold", () => {
	it("keeps a held child's answer from the parent until the user releases it", async () => {
		const root = await rootSession();
		await root.provider.setHold({ ...root.ref("worker"), held: true });
		root.pi.sendMessage.mockClear();
		settleChild(root.worker, "held answer");
		await tick();

		expect(subagentNotices(root.pi)).toEqual([]);
		expect(root.provider.snapshot().nodes.find((node: any) => key(node.path) === key(["worker"])))
			.toMatchObject({ held: true, heldSettlement: "idle" });

		await root.provider.setHold({ ...root.ref("worker"), held: false });
		await tick();
		expect(noticesContaining(root.pi, "held answer")).toEqual([[expect.objectContaining({ content: expect.stringContaining("<agent_idle") }), { triggerTurn: true }]]);
		expect(root.provider.snapshot().nodes.find((node: any) => key(node.path) === key(["worker"])))
			.toMatchObject({ held: false });
	});

	it("reports a held child to an active wait and delivers its answer through the wait on release", async () => {
		const root = await rootSession();
		await root.provider.setHold({ ...root.ref("worker"), held: true });
		settleChild(root.worker, "held answer");
		root.pi.sendMessage.mockClear();

		const waiting = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		expect(waiting.updates.at(-1).details.subagent).toMatchObject({
			kind: "await",
			state: "active",
			data: { result: { statuses: [{ path: ["worker"], state: "held" }] } },
		});
		await expectPending(waiting.result);

		await root.provider.setHold({ ...root.ref("worker"), held: false });
		const result = await waiting.result;
		expect(result.content[0].text).toContain("held answer");
		expect(result.structuredContent.agents).toEqual([expect.objectContaining({ id: "worker", status: "idle", output: "held answer" })]);
		await tick();
		expect(noticesContaining(root.pi, "held answer")).toEqual([]);
	});

	it("marks the released answer as a replacement when a new run started during the hold", async () => {
		const root = await rootSession();
		await root.provider.setHold({ ...root.ref("worker"), held: true });
		root.pi.sendMessage.mockClear();
		settleChild(root.worker, "first answer");
		root.worker.hooks.onEvent({ type: "agent_start" });
		settleChild(root.worker, "second answer");

		await root.provider.setHold({ ...root.ref("worker"), held: false });
		await tick();
		expect(noticesContaining(root.pi, "first answer")).toEqual([]);
		const [[message]] = noticesContaining(root.pi, "second answer");
		expect(message.content).toContain("may not be the one you are waiting for");
		expect(message.details.subagent).toEqual([expect.objectContaining({
			kind: "completion",
			data: expect.objectContaining({ result: expect.objectContaining({ output: "second answer", replacedHeldResult: true }) }),
		})]);
	});
});

describe("await_agents", () => {
	it("returns an awaited answer in the result instead of a separate notice", async () => {
		const root = await rootSession();
		root.pi.sendMessage.mockClear();
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		settleChild(root.worker, "saved answer");

		const result = await waiting.result;
		expect(result.content[0].text).toContain("saved answer");
		expect(result.structuredContent.agents).toEqual([expect.objectContaining({ id: "worker", status: "idle", output: "saved answer" })]);
		expect(result.details.subagent).toMatchObject({
			kind: "await",
			state: "complete",
			data: { result: { statuses: [expect.objectContaining({ path: ["worker"], state: "idle", output: "saved answer" })] } },
		});
		await tick();
		expect(noticesContaining(root.pi, "saved answer")).toEqual([]);
	});

	it("streams per-child statuses through onUpdate and serves them to late views", async () => {
		const root = await rootSession();
		await execute(root.tools, "subagent", { agents: [{ id: "scout", task: "look", channels: [] }] }, root.ctx);
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker", "scout"] }, root.ctx, { toolCallId: "await-call" });
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		settleChild(root.worker, "worker answer");

		const latest = waiting.updates.at(-1);
		expect(latest.details.subagent).toMatchObject({
			kind: "await",
			state: "active",
			data: { parameters: { agents: ["worker", "scout"] }, result: { statuses: [
				expect.objectContaining({ path: ["worker"], state: "idle", output: "worker answer" }),
				expect.objectContaining({ path: ["scout"], state: "running" }),
			] } },
		});
		expect(root.provider.presenters.runningToolProgress({ sessionId: "root-session", toolCallId: "await-call" })).toEqual(latest.details);

		settleChild(managed.created[1], "scout answer");
		await waiting.result;
		expect(root.provider.presenters.runningToolProgress({ sessionId: "root-session", toolCallId: "await-call" })).toBeUndefined();
	});

	it("ends a wait as removed when the user tears down the awaited child", async () => {
		const root = await rootSession();
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));

		await root.provider.teardown(root.ref("worker"));
		const result = await waiting.result;
		expect(result.structuredContent.agents).toEqual([expect.objectContaining({ id: "worker", status: "removed" })]);
		expect(result.content[0].text).toContain("<agent_removed");
	});

	it("reports a user stop during a wait as stopped", async () => {
		const root = await rootSession();
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));

		await root.provider.stop({ ...root.ref("worker"), expectedSessionId: root.worker.child.sessionId });
		root.worker.hooks.onEvent({ type: "agent_settled", aborted: true });
		const result = await waiting.result;
		expect(result.structuredContent.agents).toEqual([expect.objectContaining({ id: "worker", status: "stopped" })]);
		expect(result.content[0].text).toContain("<agent_stopped");
	});

	it("ends at once when a child message reached the parent before the wait", async () => {
		const root = await rootSession();
		await root.handlers.get("agent_start")?.({ type: "agent_start" }, root.ctx);
		root.pi.sendMessage.mockClear();
		await root.worker.config.scope.uplink.send({ to: "parent", message: "need a decision", expectResponse: false });

		const result = await runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx).result;
		expect(result.structuredContent).toMatchObject({ interrupted: true, agents: [expect.objectContaining({ id: "worker", status: "running" })] });
		expect(result.content[0].text).toMatch(/before this wait began/);

		expect(root.handlers.get("turn_end")?.({ type: "turn_end", outcome: "continue" }, root.ctx)).toEqual({ continue: true });
		expect(noticesContaining(root.pi, "need a decision")).toEqual([[expect.anything(), { triggerTurn: false }]]);
	});

	it("ends when a message arrives and reports the current child states", async () => {
		const root = await rootSession();
		await execute(root.tools, "subagent", { agents: [{ id: "scout", task: "inspect", channels: [] }] }, root.ctx);
		await root.handlers.get("agent_start")?.({ type: "agent_start" }, root.ctx);
		root.pi.sendMessage.mockClear();
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker", "scout"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		root.worker.hooks.onEvent({ type: "agent_settled" });
		await execute(root.tools, "send", { to: "worker", message: "continue", expectResponse: false }, root.ctx);
		await managed.created[1].config.scope.uplink.send({ to: "parent", message: "update", expectResponse: false });

		const result = await waiting.result;
		expect(result.structuredContent).toMatchObject({ interrupted: true, agents: [
			expect.objectContaining({ id: "worker", status: "running" }),
			expect.objectContaining({ id: "scout", status: "running" }),
		] });
		expect(result.content[0].text).toContain("Wait interrupted");
		expect(result.details.subagent).toMatchObject({ kind: "await", data: { result: { interrupted: true } } });

		await root.handlers.get("turn_end")?.({ type: "turn_end", outcome: "continue" }, root.ctx);
		expect(noticesContaining(root.pi, "update")).toEqual([[expect.objectContaining({ content: expect.stringContaining("<agent_message") }), { triggerTurn: false }]]);
	});

	it("leaves a completion outside the wait as a notice for after the wait", async () => {
		const root = await rootSession();
		await execute(root.tools, "subagent", { agents: [{ id: "scout", task: "inspect", channels: [] }] }, root.ctx);
		await root.handlers.get("agent_start")?.({ type: "agent_start" }, root.ctx);
		root.pi.sendMessage.mockClear();
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		settleChild(managed.created[1], "scout answer");
		expect(root.handlers.get("turn_end")?.({ type: "turn_end", outcome: "continue" }, root.ctx)).toBeUndefined();
		settleChild(root.worker, "worker answer");

		const result = await waiting.result;
		expect(result.content[0].text).not.toContain("scout answer");
		committedEntries.push({ type: "message", message: { role: "toolResult", toolName: "await_agents", isError: false, details: result.details } });
		await root.handlers.get("turn_end")?.({ type: "turn_end", outcome: "continue" }, root.ctx);
		expect(noticesContaining(root.pi, "scout answer")).toHaveLength(1);
		expect(noticesContaining(root.pi, "worker answer")).toEqual([]);
	});

	it("waits for a new run when a child becomes active before its agent_start event", async () => {
		const root = await rootSession();
		root.worker.hooks.onEvent({ type: "agent_settled" });
		root.worker.hooks.onEvent({ type: "tool_execution_start", toolName: "read", args: {} });
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		await expectPending(waiting.result);

		root.worker.hooks.onEvent({ type: "agent_start" });
		root.worker.hooks.onEvent({ type: "agent_settled" });
		expect((await waiting.result).structuredContent.agents).toEqual([expect.objectContaining({ id: "worker", status: "idle" })]);
	});

	it("waits for work sent to an idle child before its next agent_start", async () => {
		const root = await rootSession();
		const child = makePi();
		await createSubagentsExtension(root.worker.config.scope)(child.pi as any);
		await startSession(child.handlers, makeContext(root.worker.child.sessionFile));
		const first = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(first.updates.length).toBeGreaterThan(0));
		root.worker.hooks.onEvent({ type: "agent_settled" });
		await first.result;

		await execute(root.tools, "send", { to: "worker", message: "continue", expectResponse: false }, root.ctx);
		await tick();
		expect(child.pi.sendMessage.mock.calls.some(([message]) => message.content.includes("continue"))).toBe(true);
		const status = await execute(root.tools, "check_status", { agent: "worker" }, root.ctx);
		expect(status.structuredContent.agents).toContainEqual(expect.objectContaining({ id: "worker", state: "running" }));

		const waiting = runTool(root.tools, "await_agents", { agents: ["worker"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		await expectPending(waiting.result);
		root.worker.hooks.onEvent({ type: "agent_start" });
		root.worker.hooks.onEvent({ type: "agent_settled" });
		expect((await waiting.result).structuredContent.agents).toEqual([expect.objectContaining({ id: "worker", status: "idle" })]);
	});

	it("returns every requested status when one child settled before the wait", async () => {
		const root = await rootSession();
		await execute(root.tools, "subagent", { agents: [{ id: "scout", task: "inspect", channels: [] }] }, root.ctx);
		settleChild(root.worker, "worker done");
		const waiting = runTool(root.tools, "await_agents", { agents: ["worker", "scout"] }, root.ctx);
		await vi.waitFor(() => expect(waiting.updates.length).toBeGreaterThan(0));
		settleChild(managed.created[1], "scout done");

		const result = await waiting.result;
		expect(result.structuredContent.agents.map((agent: any) => agent.id)).toEqual(["worker", "scout"]);
	});
});

describe("tool cards", () => {
	it("streams the delegation card through onUpdate and returns the settled card", async () => {
		const root = await rootSession();
		const spawning = runTool(root.tools, "subagent", { agents: [{ id: "scout", task: "look", channels: [] }] }, root.ctx);
		const result = await spawning.result;

		expect(spawning.updates[0].details.subagent).toMatchObject({
			kind: "delegation",
			state: "active",
			data: { parameters: { agents: [{ id: "scout", task: "look" }], fork: false }, result: { children: [expect.objectContaining({ path: ["scout"], task: "look" })] } },
		});
		expect(result.details.subagent).toMatchObject({
			kind: "delegation",
			state: "complete",
			data: { result: { children: [expect.objectContaining({ path: ["scout"], status: "running" })] } },
		});
	});

	it("streams a blocking send from waiting to the responder's partial reply, then the full reply", async () => {
		const root = await rootSession();
		const child = makePi();
		await createSubagentsExtension(root.worker.config.scope)(child.pi as any);
		const childCtx = makeContext(root.worker.child.sessionFile);
		await startSession(child.handlers, childCtx);

		const sending = runTool(root.tools, "send", { to: "worker", message: "question", expectResponse: true }, root.ctx);
		await vi.waitFor(() => expect(child.pi.sendMessage.mock.calls.some(([message]) => message.content.includes("question"))).toBe(true));
		const request = child.pi.sendMessage.mock.calls.find(([message]) => message.content.includes("question"))![0];
		const correlationId = /correlation_id="([^"]+)"/.exec(request.content)![1];
		expect(sending.updates.at(-1).details.subagent).toMatchObject({ kind: "send", state: "active", data: { result: { phase: "waiting" } } });

		await child.handlers.get("message_update")?.({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				toolCall: { id: "reply-call", name: "respond", arguments: { correlationId, message: "partial" } },
			},
		}, childCtx);
		expect(sending.updates.at(-1).details.subagent).toMatchObject({
			kind: "send",
			state: "active",
			data: { parameters: { to: "worker", message: "question", expectResponse: true }, result: { phase: "responding", response: "partial" } },
		});

		const reply = await execute(child.tools, "respond", { correlationId, message: "full answer" }, childCtx);
		const result = await sending.result;
		expect(result.content[0].text).toBe("full answer");
		expect(result.details.subagent).toMatchObject({ kind: "send", state: "complete", data: { result: { phase: "complete", response: "full answer" } } });
		expect(reply.details.subagent).toMatchObject({ kind: "respond", data: { parameters: { to: [], message: "full answer" } } });
	});

	it("rejects a blocking send the target declines", async () => {
		const root = await rootSession();
		const received: RoutedMessage[] = [];
		root.worker.config.scope.uplink.subscribe((message: RoutedMessage) => received.push(message));
		const sending = runTool(root.tools, "send", { to: "worker", message: "question", expectResponse: true }, root.ctx);
		await vi.waitFor(() => expect(received).toHaveLength(1));

		await root.worker.config.scope.uplink.reject(received[0].correlationId, "declined");
		await expect(sending.result).rejects.toThrow("declined");
	});

	it("delivers a deferred reply as a later message notice", async () => {
		const root = await rootSession();
		const controller = new AbortController();
		const received: RoutedMessage[] = [];
		root.worker.config.scope.uplink.subscribe((message: RoutedMessage) => received.push(message));
		const sending = runTool(root.tools, "send", { to: "worker", message: "question", expectResponse: true }, root.ctx, { signal: controller.signal });
		await vi.waitFor(() => expect(received).toHaveLength(1));
		controller.abort();

		const result = await sending.result;
		expect(result.structuredContent).toMatchObject({ deferred: true, correlationId: received[0].correlationId });
		expect(result.details.subagent).toMatchObject({ kind: "send", state: "aborted" });
		await root.worker.config.scope.uplink.respond(received[0].correlationId, "late answer");
		await vi.waitFor(() => expect(noticesContaining(root.pi, "late answer")).toHaveLength(1));
		const [[notification]] = noticesContaining(root.pi, "late answer");
		expect(notification.details.subagent).toEqual([expect.objectContaining({
			kind: "message_received",
			data: expect.objectContaining({ parameters: { from: ["worker"], message: "late answer", expectResponse: false } }),
		})]);
	});

	it("reports a deferred send failure as a failed send card", async () => {
		const root = await rootSession();
		const controller = new AbortController();
		const received: RoutedMessage[] = [];
		root.worker.config.scope.uplink.subscribe((message: RoutedMessage) => received.push(message));
		const sending = runTool(root.tools, "send", { to: "worker", message: "question", expectResponse: true }, root.ctx, { signal: controller.signal });
		await vi.waitFor(() => expect(received).toHaveLength(1));
		controller.abort();
		await sending.result;

		await root.worker.config.scope.uplink.reject(received[0].correlationId, "declined");
		await vi.waitFor(() => expect(noticesContaining(root.pi, "declined")).toHaveLength(1));
		const [[notification]] = noticesContaining(root.pi, "declined");
		expect(notification.details.subagent).toEqual([expect.objectContaining({
			kind: "send",
			state: "error",
			data: expect.objectContaining({ parameters: expect.objectContaining({ message: "question" }), result: expect.objectContaining({ error: "declined" }) }),
		})]);
	});
});

describe("presentation provider", () => {
	it("registers one provider for the session lifetime and withdraws it at shutdown", async () => {
		const root = await rootSession();
		await execute(root.tools, "teardown", { agent: "worker" }, root.ctx);
		await execute(root.tools, "subagent", { agents: [{ id: "worker", task: "again", channels: [] }] }, root.ctx);
		root.bus.emit(SUBAGENT_PROVIDER_REQUEST, {});

		expect(new Set(root.bus.responses.map((response) => response.provider))).toEqual(new Set([root.provider]));
		expect(root.provider.snapshot().ready).toBe(true);
		await root.handlers.get("session_shutdown")?.({}, root.ctx);
		expect(root.bus.responses.at(-1)).toEqual({ provider: undefined });
	});

	it("publishes ready after restoring persisted children", async () => {
		const rootSessionFile = path.join(tmpRoot!, "root.jsonl");
		const workerSessionFile = path.join(tmpRoot!, "root.subagents", "sessions", "worker.jsonl");
		fs.mkdirSync(path.dirname(workerSessionFile), { recursive: true });
		fs.writeFileSync(rootSessionFile, "");
		fs.writeFileSync(workerSessionFile, "");
		appendAgentAdded(ensurePersistence(rootSessionFile), {
			id: "worker", kind: "agent", task: "restore worker", channels: [], sessionFile: workerSessionFile, sessionId: "worker-session",
		});
		const root = makePi();
		const bus = makeEventBus();
		(root.pi as any).events = bus;
		await createSubagentsExtension({ kind: "root" })(root.pi as any);
		await root.handlers.get("session_start")?.({ reason: "resume" }, makeContext(rootSessionFile));
		await vi.waitFor(() => expect(bus.topology.map((event) => event.kind)).toContain("ready"));

		const kinds = bus.topology.map((event) => event.kind);
		expect(kinds.filter((kind) => kind === "ready")).toHaveLength(1);
		expect(kinds.indexOf("node_added")).toBeLessThan(kinds.indexOf("ready"));
		const provider = bus.responses.at(-1)?.provider;
		expect(provider.snapshot()).toMatchObject({ ready: true, nodes: [expect.objectContaining({ path: ["worker"] })] });
	});

	it("merges the child's last action into one activity field that survives settle", async () => {
		const root = await rootSession();
		root.worker.hooks.onEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "rg lastActivity src" } });
		settleChild(root.worker, "final answer\nwith a newline");

		const node = root.provider.snapshot().nodes.find((candidate: any) => key(candidate.path) === key(["worker"]));
		expect(node.state).toBe("idle");
		expect(node.activity).toBe("final answer with a newline");
		expect(node.lastOutput).toBeUndefined();
	});
});

describe("root orchestration integration", () => {
	it("keeps the session manager and router alive across empty teardown and respawn", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const firstContext = makeContext(parentSessionFile, {
			model: { provider: "astra", id: "first" },
			modelRegistry: { getAvailable: () => [{ provider: "astra", id: "first" }] },
		});
		await startSession(handlers, firstContext);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "first run", channels: [] }],
		}, firstContext);
		await execute(tools, "teardown", { agent: "worker" }, firstContext);

		const secondContext = makeContext(parentSessionFile, {
			model: { provider: "astra", id: "second" },
			modelRegistry: { getAvailable: () => [{ provider: "astra", id: "second" }] },
		});
		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "second run", channels: [] }],
		}, secondContext);

		expect(managed.created.map((entry) => entry.config.modelRef)).toEqual([
			"astra/first",
			"astra/second",
		]);
		await expect(execute(tools, "send", {
			to: "worker",
			message: "route after empty teardown",
			expectResponse: false,
		}, secondContext)).resolves.toMatchObject({
			content: [{ text: "Message sent to worker." }],
		});
		await expect(execute(tools, "check_status", { agent: "worker" }, secondContext))
			.resolves.toMatchObject({ content: [{ text: expect.stringContaining("State: running") }] });
	});

	it("keeps the router open and parent-only after a failed staged spawn", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		let failFirst = true;
		managed.setOnCreate(async ({ config }) => {
			if (failFirst && config.path.at(-1) === "failed") {throw new Error("construction failed");}
		});
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await expect(execute(tools, "subagent", {
			agents: [{ id: "failed", task: "fail", channels: [] }],
		}, ctx)).rejects.toThrow("construction failed");
		failFirst = false;
		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "succeed", channels: [] }],
		}, ctx);

		await expect(execute(tools, "send", {
			to: "worker",
			message: "route after rollback",
			expectResponse: false,
		}, ctx)).resolves.toMatchObject({ content: [{ text: "Message sent to worker." }] });
	});

	it("uses one session-start model catalog for fmodel completions", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		let available = [{ provider: "first", id: "model", contextWindow: 10_000 }];
		const { pi, handlers, commands } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile, { modelRegistry: { getAvailable: () => available } });
		await startSession(handlers, ctx);

		available = [{ provider: "second", id: "model", contextWindow: 20_000 }];
		const completions = commands.get("fmodel").getArgumentCompletions;
		expect(completions("first/")).toEqual([{ value: "first/model", label: "first/model" }]);
		expect(completions("second/")).toBeNull();
	});

	it("keeps root status and run errors in the registry snapshot", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);
		await execute(tools, "subagent", { agents: [{ id: "worker", task: "inspect", channels: [] }] }, ctx);
		const registry = managed.created[0].config.scope.registry as AgentSessionRegistry;

		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		expect(registry.getSnapshot([])?.operational.state).toBe("running");
		await handlers.get("agent_end")?.({
			type: "agent_end",
			willRetry: false,
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "root failed" }],
		}, ctx);
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(registry.getSnapshot([])?.operational).toMatchObject({ state: "errored", lastError: "root failed" });
		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		expect(registry.getSnapshot([])?.operational).toMatchObject({ state: "running", lastError: undefined });
	});

	it("deduplicates tier warnings in the session turn owner", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		fs.mkdirSync(path.join(tmpRoot!, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tmpRoot!, ".pi", "model-tiers.json"), JSON.stringify({ cheap: "missing/model" }));
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [
				{ id: "first", task: "one", model: "cheap", channels: [] },
				{ id: "second", task: "two", model: "cheap", channels: [] },
			],
		}, ctx);

		const warnings = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
			.filter(([, type]) => type === "warning");
		expect(warnings).toHaveLength(1);
	});

	it("keeps a concurrent spawn routable when the last-child teardown finishes first", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "old", task: "remove me", channels: [] }],
		}, ctx);

		// The TUI widget import suspends this command after it has obtained the
		// per-session manager. Teardown wins that gap, which used to clear the
		// extension's manager slot before this spawn committed to the registry.
		const racingSpawn = execute(tools, "subagent", {
			agents: [{ id: "new", task: "survive the race", channels: [] }],
		}, ctx);
		await execute(tools, "teardown", { agent: "old" }, ctx);
		await racingSpawn;

		await expect(execute(tools, "send", {
			to: "new",
			message: "still reachable",
			expectResponse: false,
		}, ctx)).resolves.toMatchObject({
			content: [{ text: "Message sent to new." }],
		});
		await expect(execute(tools, "check_status", { agent: "new" }, ctx))
			.resolves.toMatchObject({ content: [{ text: expect.stringContaining("State: running") }] });
	});

	it("keeps the registry presentation subscription until session shutdown, not empty teardown", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const unsubscribe = vi.fn();
		vi.spyOn(AgentSessionRegistry.prototype, "subscribe").mockReturnValue(unsubscribe);
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "temporary", channels: [] }],
		}, ctx);
		await execute(tools, "teardown", { agent: "worker" }, ctx);
		expect(unsubscribe).not.toHaveBeenCalled();

		await handlers.get("session_shutdown")?.({}, ctx);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("does not reuse skill paths from a removed id when the session still has other children", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		fs.mkdirSync(path.join(tmpRoot!, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpRoot!, ".pi", "agents", "skilled.md"),
			`---\nname: skilled\ndescription: Has skills\nskills: debugging\n---\nWork.`,
		);
		const { pi, tools, handlers } = makePi();
		pi.getCommands.mockReturnValue([
			{
				name: "skill:debugging",
				source: "skill",
				sourceInfo: { path: "/skills/debugging/SKILL.md", source: "local", scope: "user", origin: "top-level" },
			},
		]);
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [
				{ id: "worker", agent: "skilled", task: "use skills", channels: [] },
				{ id: "peer", task: "stay alive", channels: [] },
			],
		}, ctx);
		await execute(tools, "teardown", { agent: "worker" }, ctx);
		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "no skills", channels: [] }],
		}, ctx);

		expect(managed.created[0].config.skillPaths).toEqual(["/skills/debugging/SKILL.md"]);
		expect(managed.created[2].config.skillPaths).toEqual([]);
	});

	it("owns SDK-native children, projects lifecycle/status updates, and records replacement metadata", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		expect(managed.createManagedChildSession).toHaveBeenCalledTimes(1);
		const created = managed.created[0];
		expect(created.config).toMatchObject({
			path: ["worker"],
			target: { kind: "new" },
			toolPolicy: { allowedTools: undefined, excludeTools: ["ask_user"] },
			scope: {
				kind: "child",
				registry: expect.anything(),
				path: ["worker"],
				identity: { id: "worker", task: "inspect", channels: ["parent"] },
			},
		});
		expect(created.child.submit).toHaveBeenCalledWith("Task: inspect", "followUp");
		expect(ctx.ui.setWidget).toHaveBeenCalled();

		created.hooks.onEvent({ type: "agent_start" });
		const runningStatus = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(runningStatus.content[0].text).toMatch(/running/i);
		expect(runningStatus.content[0].text).not.toMatch(/failed/i);
		created.hooks.onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				model: "provider/model",
				thinkingLevel: "high",
				usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } },
				content: [{ type: "text", text: "finished" }],
			},
		});
		created.hooks.onEvent({ type: "agent_end", willRetry: false, messages: [] });
		expect(pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("<agent_idle"),
			}),
			{ triggerTurn: true },
		);
		created.hooks.onEvent({ type: "agent_settled" });

		const status = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(status.content[0].text).toContain("worker");
		expect(status.content[0].text).toMatch(/idle/i);
		expect(status.content[0].text).toContain("Model: provider/model:high");
		expect(status.content[0].text).toContain("finished");
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("<agent_idle"),
			}),
			{ triggerTurn: true },
		);

		created.hooks.onSessionChanged({
			sessionId: "replacement-session",
			sessionFile: path.join(tmpRoot!, "replacement.jsonl"),
			cwd: tmpRoot!,
		});
		const lifecycleLog = fs.readFileSync(path.join(tmpRoot!, "parent.subagents", "agents.jsonl"), "utf8");
		expect(lifecycleLog.match(/"type":"agent_added"/g)).toHaveLength(2);
		expect(lifecycleLog).toContain("replacement-session");

		await execute(tools, "subagent", {
			agents: [{ id: "peer", task: "coordinate", channels: ["worker"] }],
		}, ctx);
		expect(managed.createManagedChildSession).toHaveBeenCalledTimes(2);
		expect(managed.created[1].config.scope.identity.channels).toEqual(["worker", "parent"]);

		await execute(tools, "interrupt", { agent: "worker" }, ctx);
		expect(created.child.abort).toHaveBeenCalledTimes(1);
	});

	it("returns teardown usage in pi's nested-tool usage shape", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		const worker = managed.created[0];
		worker.hooks.onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				model: "provider/model",
				usage: {
					input: 10,
					output: 4,
					cacheRead: 2,
					cacheWrite: 0,
					cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
				},
				content: [{ type: "text", text: "finished" }],
			},
		});
		// A child teardown carries the grandchild's usage as a tool result. The
		// parent must retain it until its own teardown returns the subtree total.
		worker.hooks.onEvent({
			type: "tool_execution_end",
			toolCallId: "nested-call",
			parentToolCallId: "outer-call",
			toolName: "classify",
			result: {
				content: [{ type: "text", text: "nested" }],
				usage: {
					input: 100,
					output: 100,
					cacheRead: 100,
					cacheWrite: 100,
					totalTokens: 400,
					cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
				},
			},
			isError: false,
		});
		worker.hooks.onEvent({
			type: "tool_execution_end",
			toolCallId: "teardown-call",
			toolName: "teardown",
			result: {
				content: [{ type: "text", text: "removed" }],
				usage: {
					input: 3,
					output: 1,
					cacheRead: 4,
					cacheWrite: 0,
					totalTokens: 8,
					cost: { input: 0.005, output: 0.006, cacheRead: 0.007, cacheWrite: 0.008, total: 0.02 },
				},
			},
			isError: false,
		});

		const result = await execute(tools, "teardown", { agent: "worker" }, ctx);
		expect(result.usage).toEqual({
			input: 13,
			output: 5,
			cacheRead: 6,
			cacheWrite: 0,
			totalTokens: 24,
			cost: { input: 0.006, output: 0.008, cacheRead: 0.01, cacheWrite: 0.012, total: 0.03 },
		});
	});

	it("repairs a stale errored state when assistant usage proves the run continued", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		const worker = managed.created[0];

		worker.hooks.onEvent({ type: "agent_end", willRetry: false, messages: [{
			role: "assistant",
			stopReason: "error",
			errorMessage: "stale setup error",
		}] });
		worker.hooks.onEvent({ type: "agent_settled" });
		expect(worker.config.scope.registry.getSnapshot(["worker"]).operational.state).toBe("errored");

		// A tool event is already authoritative evidence that the child is active,
		// even before the next assistant usage update arrives.
		worker.hooks.onEvent({
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "src/index.ts" },
		});
		expect(worker.config.scope.registry.getSnapshot(["worker"]).operational.state).toBe("running");

		// The provider nevertheless produced an assistant message. Usage is live
		// evidence that this child is running, so the widget must not stay red.
		worker.hooks.onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				model: "provider/model",
				usage: { input: 20, output: 6, cacheRead: 4, cacheWrite: 0, cost: { total: 0.02 } },
				content: [{ type: "text", text: "still working" }],
			},
		});
		const running = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(running.content[0].text).toMatch(/State: running/i);
		expect(worker.config.scope.registry.getSnapshot(["worker"]).operational.usage.input).toBe(20);

		worker.hooks.onEvent({ type: "agent_end", willRetry: false, messages: [] });
		worker.hooks.onEvent({ type: "agent_settled" });
		const idle = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(idle.content[0].text).toMatch(/State: idle/i);
	});

	it("preserves the active marker when a fork directive follows a resumed run", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		managed.setOnCreate(async ({ config, hooks }) => {
			if (config.target.kind === "fork") {hooks.onEvent({ type: "agent_start" });}
		});
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "fork", { id: "clone", task: "continue the source work" }, ctx);
		const status = await execute(tools, "check_status", { agent: "clone" }, ctx);
		expect(status.content[0].text).toMatch(/State: running/i);
	});

	it("recursively restores a persisted child subtree after the root session resumes", async () => {
		const rootSessionFile = path.join(tmpRoot!, "root.jsonl");
		const workerSessionFile = path.join(tmpRoot!, "root.subagents", "sessions", "worker.jsonl");
		const scoutSessionFile = path.join(tmpRoot!, "root.subagents", "sessions", "worker.subagents", "sessions", "scout.jsonl");
		const probeSessionFile = path.join(
			tmpRoot!,
			"root.subagents",
			"sessions",
			"worker.subagents",
			"sessions",
			"scout.subagents",
			"sessions",
			"probe.jsonl",
		);
		fs.mkdirSync(path.dirname(probeSessionFile), { recursive: true });
		fs.writeFileSync(rootSessionFile, "");
		fs.writeFileSync(workerSessionFile, "");
		fs.writeFileSync(scoutSessionFile, "");
		fs.writeFileSync(probeSessionFile, "");

		appendAgentAdded(ensurePersistence(rootSessionFile), {
			id: "worker",
			kind: "agent",
			task: "restore worker",
			channels: [],
			sessionFile: workerSessionFile,
			sessionId: "worker-session",
		});
		appendAgentAdded(ensurePersistence(workerSessionFile), {
			id: "scout",
			kind: "agent",
			task: "restore scout",
			channels: [],
			sessionFile: scoutSessionFile,
			sessionId: "scout-session",
		});
		appendAgentAdded(ensurePersistence(scoutSessionFile), {
			id: "probe",
			kind: "agent",
			task: "restore probe",
			channels: [],
			sessionFile: probeSessionFile,
			sessionId: "probe-session",
		});

		managed.setOnCreate(async ({ config }) => {
			if (config.target.kind !== "resume") {return;}
			const child = makePi();
			await createSubagentsExtension(config.scope)(child.pi as any);
			await child.handlers.get("session_start")?.(
				{ reason: "resume" },
				makeContext(config.target.sessionFile),
			);
		});

		const root = makePi();
		await createSubagentsExtension({ kind: "root" })(root.pi as any);
		await root.handlers.get("session_start")?.({ reason: "resume" }, makeContext(rootSessionFile));

		await vi.waitFor(() => expect(managed.created).toHaveLength(3));
		const workerScope = managed.created[0].config.scope as SubagentScope;
		expect(workerScope.registry.listDescendants([]).map((node) => node.path)).toEqual([
			["worker"],
			["worker", "scout"],
			["worker", "scout", "probe"],
		]);
	});

	it("seeds a restored idle child's activity from its last assistant text", async () => {
		const rootSessionFile = path.join(tmpRoot!, "root.jsonl");
		const workerSessionFile = path.join(tmpRoot!, "root.subagents", "sessions", "worker.jsonl");
		fs.mkdirSync(path.dirname(workerSessionFile), { recursive: true });
		fs.writeFileSync(rootSessionFile, "");
		fs.writeFileSync(workerSessionFile, JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				model: "provider/model",
				content: [{ type: "text", text: "restored answer\nsecond line" }],
				usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			},
		}));
		appendAgentAdded(ensurePersistence(rootSessionFile), {
			id: "worker",
			kind: "agent",
			task: "restore worker",
			channels: [],
			sessionFile: workerSessionFile,
			sessionId: "worker-session",
		});

		const root = makePi();
		let provider: any;
		const listeners = new Map<string, Set<(data: any) => void>>();
		(root.pi as any).events = {
			on(name: string, listener: (data: any) => void) {
				const group = listeners.get(name) ?? new Set();
				group.add(listener);
				listeners.set(name, group);
				return () => group.delete(listener);
			},
			emit(name: string, data: any) {
				if (name === "pimote:subagents:response") {provider = data.provider;}
				for (const listener of listeners.get(name) ?? []) {listener(data);}
			},
		};
		await createSubagentsExtension({ kind: "root" })(root.pi as any);
		await root.handlers.get("session_start")?.({ reason: "resume" }, makeContext(rootSessionFile));
		await vi.waitFor(() => expect(managed.created).toHaveLength(1));

		const node = provider.snapshot().nodes.find((candidate: any) => JSON.stringify(candidate.path) === JSON.stringify(["worker"]));
		expect(node.state).toBe("idle");
		expect(node.activity).toBe("restored answer second line");
		expect(node.lastOutput).toBeUndefined();
	});

	it("refuses to await an agent already blocked on the parent's response", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		managed.created[0].hooks.onEvent({ type: "agent_start" });

		// The blocking send lands before the wait starts, so its notification is
		// already flushed out of the queue — the wait cannot rely on draining it.
		const uplink: MessagePort = managed.created[0].config.scope.uplink;
		await uplink.send({
			to: "parent",
			message: "which approach should I take?",
			expectResponse: true,
			correlationId: "corr-blocked",
		});
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("corr-blocked") }),
			expect.anything(),
		);

		const settled = await Promise.race([
			execute(tools, "await_agents", {}, ctx),
			new Promise<string>((resolve) => {
				setTimeout(() => resolve("WAIT DID NOT RETURN"), 100);
			}),
		]);
		expect(settled.content[0].text).toContain("worker");
		expect(settled.content[0].text).toMatch(/respond/i);
		expect(settled.structuredContent).toMatchObject({ interrupted: true, error: expect.stringContaining("Cannot wait") });
	});

	it("creates a separate registry for each root session", async () => {
		const firstParentSessionFile = path.join(tmpRoot!, "first-parent.jsonl");
		const secondParentSessionFile = path.join(tmpRoot!, "second-parent.jsonl");
		fs.writeFileSync(firstParentSessionFile, "");
		fs.writeFileSync(secondParentSessionFile, "");
		const first = makePi();
		const second = makePi();
		await createSubagentsExtension({ kind: "root" })(first.pi as any);
		await createSubagentsExtension({ kind: "root" })(second.pi as any);
		await startSession(first.handlers, makeContext(firstParentSessionFile));
		await startSession(second.handlers, makeContext(secondParentSessionFile));

		await execute(first.tools, "subagent", {
			agents: [{ id: "worker", task: "work in the first root", channels: [] }],
		}, makeContext(firstParentSessionFile));
		await execute(second.tools, "subagent", {
			agents: [{ id: "worker", task: "work in the second root", channels: [] }],
		}, makeContext(secondParentSessionFile));

		expect(managed.created).toHaveLength(2);
		expect(managed.created[0].config.path).toEqual(["worker"]);
		expect(managed.created[1].config.path).toEqual(["worker"]);
		expect(managed.created[0].config.scope.registry).not.toBe(managed.created[1].config.scope.registry);
	});

	it("forks from the parent session with its complete active tool set and thinking level", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		pi.getActiveTools.mockReturnValue(["read", "mcp__external__custom", "ask_user"]);
		pi.getCommands.mockReturnValue([
			{
				name: "skill:debugging",
				source: "skill",
				sourceInfo: { path: "/skills/debugging/SKILL.md", source: "local", scope: "user", origin: "top-level" },
			},
		]);
		pi.getThinkingLevel.mockReturnValue("xhigh");
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "fork", { id: "clone", task: "explore another path" }, ctx);

		expect(managed.createManagedChildSession).toHaveBeenCalledTimes(1);
		expect(managed.created[0].config).toMatchObject({
			path: ["clone"],
			target: {
				kind: "fork",
				sourceSessionFile: parentSessionFile,
				cwd: tmpRoot,
				sessionDir: path.join(tmpRoot!, "parent.subagents", "sessions"),
			},
			thinkingLevel: "xhigh",
			skillPaths: ["/skills/debugging/SKILL.md"],
			scope: {
				kind: "child",
				path: ["clone"],
				identity: { id: "clone", task: "explore another path", channels: ["parent"] },
			},
		});
		const allowedTools = managed.created[0].config.toolPolicy.allowedTools;
		expect(new Set(allowedTools)).toEqual(new Set(["read", "mcp__external__custom", "respond"]));
		expect(allowedTools).toHaveLength(3);
		expect(managed.created[0].child.submit).toHaveBeenCalledWith("Task: explore another path", "followUp");
	});

	it("restores a torn-down child without RPC", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		const first = managed.created[0];
		fs.mkdirSync(path.dirname(first.child.sessionFile), { recursive: true });
		fs.writeFileSync(first.child.sessionFile, "");

		await execute(tools, "teardown", { agent: "worker" }, ctx);
		expect(first.child.dispose).toHaveBeenCalledTimes(1);
		await execute(tools, "resurrect", {
			agents: [{
			id: "worker-restored",
			sessionId: first.child.sessionId,
			channels: [],
			task: "continue",
		}],
		}, ctx);
		expect(managed.createManagedChildSession).toHaveBeenCalledTimes(2);
		expect(managed.created[1].config).toMatchObject({
			path: ["worker-restored"],
			target: { kind: "resume", sessionFile: first.child.sessionFile },
			// Nothing declared a model, so no override reaches construction and the
			// resumed session keeps the model it last ran on.
			modelRef: undefined,
		});
	});

	it("resets the usage baseline on resurrection before the next teardown", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		const first = managed.created[0];
		fs.mkdirSync(path.dirname(first.child.sessionFile), { recursive: true });
		// The resumed session contains the usage already reported by the first
		// teardown. Resurrection must not replay it as new work.
		fs.writeFileSync(first.child.sessionFile, JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } },
				content: [{ type: "text", text: "old result" }],
			},
		}) + "\n");
		first.hooks.onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } },
				content: [{ type: "text", text: "old result" }],
			},
		});
		const firstTeardown = await execute(tools, "teardown", { agent: "worker" }, ctx);
		expect(firstTeardown.usage.cost.total).toBeCloseTo(0.01);

		await execute(tools, "resurrect", {
			agents: [{
				id: "worker-restored",
				sessionId: first.child.sessionId,
				channels: [],
				task: "continue",
			}],
		}, ctx);
		const restored = managed.created[1];
		expect(restored.config.scope.registry.getSnapshot(["worker-restored"]).operational.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		});
		restored.hooks.onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.02 } },
				content: [{ type: "text", text: "new result" }],
			},
		});
		const secondTeardown = await execute(tools, "teardown", { agent: "worker-restored" }, ctx);
		expect(secondTeardown.usage).toMatchObject({
			input: 5,
			output: 2,
			cacheRead: 1,
			cost: { total: 0.02 },
		});
	});

	it("resurrects onto an explicit model over the persisted one", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile, {
			modelRegistry: {
				getAvailable: () => [
					{ provider: "provider", id: "model" },
					{ provider: "provider", id: "other" },
				],
			},
		});
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		const first = managed.created[0];
		fs.mkdirSync(path.dirname(first.child.sessionFile), { recursive: true });
		fs.writeFileSync(first.child.sessionFile, "");
		await execute(tools, "teardown", { agent: "worker" }, ctx);

		await execute(tools, "resurrect", {
			agents: [{
				id: "worker-restored",
				sessionId: first.child.sessionId,
				channels: [],
				task: "continue",
				model: "provider/other",
			},
			],
		}, ctx);

		expect(managed.created[1].config).toMatchObject({
			target: { kind: "resume", sessionFile: first.child.sessionFile },
			modelRef: "provider/other",
		});
	});

	it("resurrects onto the persona model pin over an explicit model", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const agentsDir = path.join(tmpRoot!, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "pinned.md"), [
			"---",
			"name: pinned",
			"description: A persona with its own model pin.",
			"model: provider/pinned",
			"---",
			"",
			"You work as the pinned persona.",
		].join("\n"));
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile, {
			modelRegistry: {
				getAvailable: () => [
					{ provider: "provider", id: "model" },
					{ provider: "provider", id: "pinned" },
					{ provider: "provider", id: "other" },
				],
			},
		});
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", persona: "pinned", task: "inspect", channels: [] }],
		}, ctx);
		const first = managed.created[0];
		fs.mkdirSync(path.dirname(first.child.sessionFile), { recursive: true });
		fs.writeFileSync(first.child.sessionFile, "");
		await execute(tools, "teardown", { agent: "worker" }, ctx);

		await execute(tools, "resurrect", {
			agents: [{
				id: "worker-restored",
				sessionId: first.child.sessionId,
				channels: [],
				task: "continue",
				model: "provider/other",
			},
			],
		}, ctx);

		expect(managed.created[1].config.modelRef).toBe("provider/pinned");
	});

	it("revives an errored child on a later send but keeps a dead runtime unreachable", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }, { id: "doomed", task: "inspect", channels: [] }],
		}, ctx);
		const worker = managed.created[0];
		const doomed = managed.created[1];

		// A run that errors leaves a live session: errored, not dead.
		worker.hooks.onEvent({ type: "agent_start" });
		worker.hooks.onEvent({
			type: "agent_end",
			willRetry: false,
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider returned 401" }],
		});
		worker.hooks.onEvent({ type: "agent_settled" });
		const erroredStatus = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(erroredStatus.content[0].text).toMatch(/errored/i);

		// The operator cleared the source condition — a retry must be delivered
		// rather than replaying the cached failure.
		const retry = await execute(tools, "send", { to: "worker", message: "try again", expectResponse: false }, ctx);
		expect(retry.content[0].text).toContain("Message sent to worker.");
		worker.hooks.onEvent({ type: "agent_start" });
		const revivedStatus = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(revivedStatus.content[0].text).toMatch(/running/i);
		expect(revivedStatus.content[0].text).not.toMatch(/401/);

		// A runtime that shut itself down is genuinely gone and stays unreachable.
		doomed.hooks.onShutdownRequested();
		const deadStatus = await execute(tools, "check_status", { agent: "doomed" }, ctx);
		expect(deadStatus.content[0].text).toMatch(/dead/i);
		await expect(execute(tools, "send", { to: "doomed", message: "anyone home", expectResponse: false }, ctx))
			.rejects.toThrow(/unavailable|dead/i);
	});

	it("inherits the active parent model and thinking level when model is omitted or empty", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools, handlers } = makePi();
		pi.getThinkingLevel.mockReturnValue("xhigh");
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile, {
			model: { provider: "astra", id: "model" },
			modelRegistry: {
				getAvailable: () => [{ provider: "astra", id: "model" }],
			},
		});
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [
				{ id: "omitted", task: "inherit", channels: [] },
				{ id: "empty", agent: "", model: "", task: "inherit", channels: [] },
			],
		}, ctx);

		expect(managed.created.map((entry) => entry.config.modelRef)).toEqual(["astra/model", "astra/model"]);
		expect(managed.created.map((entry) => entry.config.thinkingLevel)).toEqual(["xhigh", "xhigh"]);
		const lifecycleLog = fs.readFileSync(path.join(tmpRoot!, "parent.subagents", "agents.jsonl"), "utf8");
		expect(lifecycleLog).not.toContain('"agent":""');
	});

	it("passes a persona's resolved model tier to the native child", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		fs.mkdirSync(path.join(tmpRoot!, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpRoot!, ".pi", "model-tiers.json"),
			JSON.stringify({ cheap: "provider/model:high" }),
		);
		fs.writeFileSync(
			path.join(tmpRoot!, ".pi", "agents", "scout.md"),
			`---\nname: scout\ndescription: Locate code\nmodel: cheap\n---\nSearch only.`,
		);

		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{ id: "scout", agent: "scout", task: "locate code" }],
		}, ctx);

		expect(managed.created[0].config.modelRef).toBe("provider/model:high");
		expect(managed.created[0].config.thinkingLevel).toBeUndefined();
	});

	it("propagates persona model, normalized tool policy, skills, and cwd to a native child", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		const childCwd = path.join(tmpRoot!, "child-project");
		fs.writeFileSync(parentSessionFile, "");
		fs.mkdirSync(path.join(tmpRoot!, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(childCwd);
		fs.writeFileSync(path.join(tmpRoot!, ".pi", "agents", "reviewer.md"), `---\nname: reviewer\ndescription: Review changes\ntools: send\nskills: debugging\nmodel: pinned/model\n---\nReview carefully.`);

		const { pi, tools, handlers } = makePi();
		pi.getCommands.mockReturnValue([
			{
				name: "skill:debugging",
				source: "skill",
				sourceInfo: { path: "/skills/debugging/SKILL.md", source: "local", scope: "user", origin: "top-level" },
			},
		]);
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile, {
			modelRegistry: {
				getAvailable: () => [{ provider: "pinned", id: "model" }],
			},
		});
		await startSession(handlers, ctx);

		await execute(tools, "subagent", {
			agents: [{
			id: "reviewer",
			agent: "reviewer",
			model: "ignored/by-persona",
			task: "review",
			cwd: childCwd,
		}],
		}, ctx);

		expect(managed.created[0].config).toMatchObject({
			path: ["reviewer"],
			target: { kind: "new", cwd: childCwd },
			modelRef: "pinned/model",
			thinkingLevel: undefined,
			skillPaths: ["/skills/debugging/SKILL.md"],
			scope: {
				path: ["reviewer"],
				identity: { id: "reviewer" },
			},
		});
		const allowedTools = managed.created[0].config.toolPolicy.allowedTools;
		expect(new Set(allowedTools)).toEqual(new Set(["send", "respond"]));
		expect(allowedTools).toHaveLength(2);
		// Adjudicated: the specialist body rides as the spawn-declared persona
		// payload; only identity XML is appended as addendum.
		expect(managed.created[0].config.persona).toEqual({ name: "reviewer", body: "Review carefully." });
		expect(managed.created[0].config.appendSystemPrompt).not.toContain("Review carefully.");
	});

	it("surfaces a wholesale workspace override in the subagent tool result", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		const childCwd = path.join(tmpRoot!, "override-project");
		const plainCwd = path.join(tmpRoot!, "plain-project");
		fs.writeFileSync(parentSessionFile, "");
		fs.mkdirSync(path.join(tmpRoot!, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(childCwd, { recursive: true });
		fs.mkdirSync(plainCwd, { recursive: true });
		fs.writeFileSync(
			path.join(childCwd, "AGENTS.md"),
			`---\nkind: persona\nname: ws-lead\n---\nYou are the workspace lead.`,
		);
		fs.writeFileSync(
			path.join(tmpRoot!, ".pi", "agents", "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes\n---\nReview carefully.`,
		);

		const { pi, tools, handlers } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);
		await startSession(handlers, ctx);

		const overridden = (await execute(
			tools,
			"subagent",
			{ agents: [{ id: "rev", persona: "reviewer", task: "review", cwd: childCwd }] },
			ctx,
		)) as { content?: { text?: string }[] };
		const plain = (await execute(
			tools,
			"subagent",
			{ agents: [{ id: "plain", persona: "reviewer", task: "review", cwd: plainCwd }] },
			ctx,
		)) as { content?: { text?: string }[] };

		const overrideText = String(overridden?.content?.[0]?.text ?? "");
		const plainText = String(plain?.content?.[0]?.text ?? "");
		expect(overrideText).toContain("persona 'reviewer' overridden by workspace persona 'ws-lead'");
		expect(overrideText).toContain(childCwd);
		expect(plainText).not.toContain("overridden by");
	});
});
