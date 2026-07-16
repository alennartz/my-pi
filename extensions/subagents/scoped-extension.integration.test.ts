import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const managed = vi.hoisted(() => {
	let sequence = 0;
	const created: Array<{ config: any; dependencies: any; hooks: any; child: any }> = [];
	const createManagedChildSession = vi.fn(async (config: any, dependencies: any, hooks: any) => {
		const localId = config.path[config.path.length - 1];
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
		created.push({ config, dependencies, hooks, child });
		return child;
	});
	return {
		created,
		createManagedChildSession,
		reset() {
			sequence = 0;
			created.length = 0;
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

import { createSubagentsExtension, type SubagentScope } from "./scoped-extension.js";
import type { AgentSessionRegistry } from "./agent-session-registry.js";
import type { MessagePort, RoutedMessage, SendReceipt } from "./message-router.js";

const registry = {} as AgentSessionRegistry;

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any) => Promise<any>;
};

function makePort(id: string): MessagePort & { emit(message: RoutedMessage): void; listeners: Set<(message: RoutedMessage) => void> } {
	const listeners = new Set<(message: RoutedMessage) => void>();
	const port = {
		id,
		send: vi.fn(async (): Promise<SendReceipt> => ({})),
		respond: vi.fn(async () => {}),
		detach: vi.fn(),
		cancel: vi.fn(),
		subscribe: vi.fn((listener: (message: RoutedMessage) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		emit(message: RoutedMessage) {
			for (const listener of listeners) listener(message);
		},
		listeners,
	};
	return port;
}

function makePi() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
		on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
		getCommands: vi.fn(() => []),
		getActiveTools: vi.fn(() => [
			"list_models", "subagent", "fork", "send", "respond", "check_status",
			"teardown", "resurrect", "await_agents", "interrupt",
		]),
		getThinkingLevel: vi.fn(() => "medium"),
		sendMessage: vi.fn(),
	};
	return { pi, tools, handlers };
}

function makeContext(parentSessionFile: string, overrides: Record<string, unknown> = {}) {
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
			getSessionName: () => "parent",
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
	if (!tool) throw new Error(`Tool ${name} was not registered`);
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

let tmpRoot: string | undefined;

beforeEach(() => {
	managed.reset();
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-subagents-test-"));
});

afterEach(() => {
	if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
	tmpRoot = undefined;
});

describe("child-scoped extension routing", () => {
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
		};
		const { pi, tools } = makePi();
		await createSubagentsExtension(scope)(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));

		await execute(tools, "send", { to: "parent", message: "hello", expectResponse: false }, ctx);
		expect(uplink.send).toHaveBeenCalledWith({
			to: "parent",
			message: "hello",
			expectResponse: false,
		});

		uplink.emit({
			from: "parent",
			message: "please answer",
			correlationId: "corr-parent",
			responseExpected: true,
		});
		await execute(tools, "respond", { correlationId: "corr-parent", message: "answer" }, ctx);
		expect(uplink.respond).toHaveBeenCalledWith("corr-parent", "answer");
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			content: expect.stringContaining("<agent_message"),
		}));
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
		})(pi as any);
		const ctx = makeContext(path.join(tmpRoot!, "parent.jsonl"));

		const models = await execute(tools, "list_models", {}, ctx);
		expect(models.content[0].text).toContain("provider/model");
		expect(models.content[0].text).toContain("200000");
		expect(models.content[0].text).toContain("1.00");

		await handlers.get("session_shutdown")?.({}, ctx);
		uplink.emit({ from: "parent", message: "after shutdown", responseExpected: false });
		expect(pi.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			content: expect.stringContaining("after shutdown"),
		}));
	});
});

describe("root orchestration integration", () => {
	it("owns SDK-native children, projects lifecycle/status updates, and records replacement metadata", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);

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
		expect(created.child.submit).toHaveBeenCalledWith("Task: inspect");
		expect(ctx.ui.setWidget).toHaveBeenCalled();

		created.hooks.onEvent({ type: "agent_start" });
		created.hooks.onEvent({
			type: "message_end",
			message: {
				role: "assistant",
				model: "provider/model",
				usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } },
				content: [{ type: "text", text: "finished" }],
			},
		});
		created.hooks.onEvent({ type: "agent_end", willRetry: false, messages: [] });
		expect(pi.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			content: expect.stringContaining("<agent_idle"),
		}));
		created.hooks.onEvent({ type: "agent_settled" });

		const status = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(status.content[0].text).toContain("worker");
		expect(status.content[0].text).toMatch(/idle/i);
		expect(status.content[0].text).toContain("finished");
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			content: expect.stringContaining("<agent_idle"),
		}));

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

	it("settles pre-agent-start headless errors and restores a torn-down session without RPC", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, "");
		const { pi, tools } = makePi();
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile);

		await execute(tools, "subagent", {
			agents: [{ id: "worker", task: "inspect", channels: [] }],
		}, ctx);
		const first = managed.created[0];
		fs.mkdirSync(path.dirname(first.child.sessionFile), { recursive: true });
		fs.writeFileSync(first.child.sessionFile, "");
		first.hooks.onUiNotify("input blocked", "error");

		const failedStatus = await execute(tools, "check_status", { agent: "worker" }, ctx);
		expect(failedStatus.content[0].text).toMatch(/failed|input blocked/i);
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
			content: expect.stringContaining("status=\"failed\""),
		}));

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
		});
	});

	it("propagates persona model, normalized tool policy, skills, and cwd to a native child", async () => {
		const parentSessionFile = path.join(tmpRoot!, "parent.jsonl");
		const childCwd = path.join(tmpRoot!, "child-project");
		fs.writeFileSync(parentSessionFile, "");
		fs.mkdirSync(path.join(tmpRoot!, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(childCwd);
		fs.writeFileSync(path.join(tmpRoot!, ".pi", "agents", "reviewer.md"), `---\nname: reviewer\ndescription: Review changes\ntools: send\nskills: debugging\nmodel: pinned/model\n---\nReview carefully.`);

		const { pi, tools } = makePi();
		pi.getCommands.mockReturnValue([{ name: "skill:debugging", source: "skill", path: "/skills/debugging/SKILL.md" }]);
		await createSubagentsExtension({ kind: "root" })(pi as any);
		const ctx = makeContext(parentSessionFile, {
			modelRegistry: {
				getAvailable: () => [{ provider: "pinned", id: "model" }],
			},
		});

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
			toolPolicy: { allowedTools: expect.arrayContaining(["send", "respond"]) },
			skillPaths: ["/skills/debugging/SKILL.md"],
			scope: {
				path: ["reviewer"],
				identity: { id: "reviewer" },
			},
		});
		expect(managed.created[0].config.appendSystemPrompt).toContain("Review carefully.");
	});
});
