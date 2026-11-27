import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, FauxProviderHandle, Message, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createEventBus,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, AgentSessionRuntime, CreateAgentSessionRuntimeFactory, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { discoverProvider } from "@pimote/sdk/subagents";
import type {
	AgentPath,
	BorrowedAgentSession,
	SubagentJsonValue,
	SubagentLease,
	SubagentPresentation,
	SubagentPresentationProvider,
	SubagentPresenters,
	SubagentToolExecution,
} from "@pimote/sdk/subagents";
import { createSubagentsExtension } from "./scoped-extension.js";
import { getPersistencePaths, loadPersistedAgents } from "./persistence.js";
import { settlementReceipts } from "./settlement-receipts.js";

// ---------------------------------------------------------------------------
// Wire and recording
// ---------------------------------------------------------------------------

type Json = SubagentJsonValue;
type JsonObject = { [key: string]: Json };

function wire<T>(value: T): T {
	// oxlint-disable-next-line unicorn/prefer-structured-clone
	return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") {return content;}
	if (!Array.isArray(content)) {return "";}
	return content.flatMap((part) => {
		const block = record(part);
		return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("");
}

type CallState = { toolName: string; args: JsonObject; argsComplete: boolean; execution: SubagentToolExecution };

/** Presents one session's native events the way a live Pimote surface does. */
class LiveRecorder {
	readonly cards = new Map<string, SubagentPresentation[] | SubagentPresentation | undefined>();
	readonly history = new Map<string, (SubagentPresentation | undefined)[]>();
	private readonly calls = new Map<string, CallState>();
	private customIndex: number;

	constructor(
		private readonly presenters: SubagentPresenters,
		private readonly ownerPath: AgentPath,
		existingEntries: readonly SessionEntry[] = [],
	) {
		this.customIndex = existingEntries.filter((entry) => this.isPresentedCustomEntry(entry)).length;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type !== "toolcall_start" && update.type !== "toolcall_delta" && update.type !== "toolcall_end") {return;}
				const block = record(update.type === "toolcall_end" ? update.toolCall : update.partial.content[update.contentIndex]);
				if (!block || typeof block.id !== "string" || typeof block.name !== "string") {return;}
				this.present(block.id, {
					toolName: block.name,
					args: (record(block.arguments) ?? {}) as JsonObject,
					argsComplete: update.type === "toolcall_end",
					execution: { state: "pending" },
				});
				return;
			}
			case "tool_execution_start":
				this.update(event.toolCallId, { execution: { state: "running" } });
				return;
			case "tool_execution_update":
				this.update(event.toolCallId, { execution: { state: "running", progress: record(event.partialResult)?.details as Json } });
				return;
			case "tool_execution_end": {
				const result = record(event.result);
				this.update(event.toolCallId, {
					execution: { state: event.isError ? "error" : "complete", details: result?.details as Json, text: textOf(result?.content) },
				});
				return;
			}
			case "message_end":
				this.messageEnd(event.message);
				return;
			default:
		}
	}

	private messageEnd(message: unknown): void {
		const value = record(message);
		if (!value) {return;}
		if (value.role === "assistant") {
			const failed = value.stopReason === "aborted" || value.stopReason === "error";
			for (const part of Array.isArray(value.content) ? value.content : []) {
				const block = record(part);
				if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") {continue;}
				this.present(block.id, {
					toolName: block.name,
					args: (record(block.arguments) ?? {}) as JsonObject,
					argsComplete: true,
					execution: failed ? { state: "aborted" } : this.calls.get(block.id)?.execution ?? { state: "pending" },
				});
			}
			return;
		}
		if (value.role === "toolResult" && typeof value.toolCallId === "string") {
			this.update(value.toolCallId, {
				execution: { state: value.isError === true ? "error" : "complete", details: value.details as Json, text: textOf(value.content) },
			});
			return;
		}
		if (value.role === "custom" && typeof value.customType === "string" && this.presenters.customTypes.includes(value.customType)) {
			const key = `custom:${this.customIndex++}`;
			const cards = wire(this.presenters.presentMessage(wire({
				ownerPath: this.ownerPath,
				customType: value.customType,
				content: textOf(value.content),
				...(value.details !== undefined ? { details: value.details as Json } : undefined),
			})));
			this.cards.set(key, cards as SubagentPresentation[] | undefined);
		}
	}

	private update(toolCallId: string, patch: Partial<CallState>): void {
		const current = this.calls.get(toolCallId);
		if (!current) {return;}
		this.present(toolCallId, { ...current, ...patch });
	}

	private present(toolCallId: string, state: CallState): void {
		this.calls.set(toolCallId, state);
		if (!this.presenters.toolNames.includes(state.toolName)) {return;}
		const card = wire(this.presenters.presentToolCall(wire({ ownerPath: this.ownerPath, toolCallId, ...state })));
		const key = `tool:${toolCallId}`;
		this.cards.set(key, card);
		this.history.set(key, [...(this.history.get(key) ?? []), card]);
	}

	private isPresentedCustomEntry(entry: SessionEntry): boolean {
		return entry.type === "custom_message" && this.presenters.customTypes.includes(entry.customType);
	}
}

/** Presents saved entries the way a Pimote snapshot does. */
function reloadCards(presenters: SubagentPresenters, ownerPath: AgentPath, entries: readonly SessionEntry[]): Map<string, unknown> {
	const saved = wire(entries);
	const results = new Map<string, Record<string, unknown>>();
	for (const entry of saved) {
		if (entry.type !== "message") {continue;}
		const message = record(entry.message);
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {results.set(message.toolCallId, message);}
	}
	const cards = new Map<string, unknown>();
	let customIndex = 0;
	for (const entry of saved) {
		if (entry.type === "custom_message" && presenters.customTypes.includes(entry.customType)) {
			const input = {
				ownerPath,
				customType: entry.customType,
				content: textOf(entry.content),
				...(entry.details !== undefined ? { details: entry.details as Json } : undefined),
			};
			cards.set(`custom:${customIndex++}`, wire(presenters.presentMessage(wire(input))));
			continue;
		}
		if (entry.type !== "message") {continue;}
		const message = record(entry.message);
		if (message?.role !== "assistant") {continue;}
		for (const part of Array.isArray(message.content) ? message.content : []) {
			const block = record(part);
			if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") {continue;}
			if (!presenters.toolNames.includes(block.name)) {continue;}
			const result = results.get(block.id);
			const execution: SubagentToolExecution = result
				? { state: result.isError === true ? "error" : "complete", details: result.details as Json, text: textOf(result.content) }
				: { state: "aborted" };
			const input = { ownerPath, toolName: block.name, toolCallId: block.id, args: record(block.arguments) ?? {}, argsComplete: true, execution };
			cards.set(`tool:${block.id}`, wire(presenters.presentToolCall(wire(input) as Parameters<SubagentPresenters["presentToolCall"]>[0])));
		}
	}
	return cards;
}

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

type Reply = AssistantMessage | Promise<AssistantMessage>;
type ChildTurn = Readonly<{ id: string; last: Message; signal: AbortSignal | undefined }>;
type ChildScript = (turn: ChildTurn) => Reply | undefined;

const IDENTITY = /<subagent_identity>\s*<id>([^<]+)<\/id>/;
const CORRELATION = /correlation_id="([^"]+)" response_expected="true"/;

function lastTextOf(message: Message): string {
	return textOf((message as { content?: unknown }).content);
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal) {return;}
		if (signal.aborted) {resolve();}
		else {signal.addEventListener("abort", () => resolve(), { once: true });}
	});
}

/**
 * The model for the root and every child. The root answers `step:<name>`
 * prompts with that step's tool calls and acknowledges anything else. A child
 * answers its task with text and an expected-response message with `respond`.
 */
class ScriptedModel {
	readonly steps = new Map<string, () => Reply>();
	readonly childScripts = new Map<string, ChildScript>();
	readonly gates = new Map<string, Promise<void>>();
	attached: (id: string) => Promise<void> = async () => {};

	reset(): void {
		this.steps.clear();
		this.childScripts.clear();
		this.gates.clear();
	}

	async reply(context: TranscriptContext, options: SimpleStreamOptions | undefined): Promise<AssistantMessage> {
		const messages = context.messages.filter((message) => (message.role as string) !== "system");
		const last = messages.at(-1);
		if (!last) {return fauxAssistantMessage("empty");}
		const id = IDENTITY.exec(getCurrentSystemPrompt(context.messages))?.[1];
		if (id === undefined) {return this.rootReply(last);}
		await this.attached(id);
		await this.gates.get(id);
		const script = this.childScripts.get(id);
		const scripted = script?.({ id, last, signal: options?.signal });
		return scripted ? await scripted : defaultChildReply(id, last);
	}

	private rootReply(last: Message): Reply {
		const step = last.role === "user" ? /^step:(\S+)/.exec(lastTextOf(last))?.[1] : undefined;
		const action = step === undefined ? undefined : this.steps.get(step);
		return action ? action() : fauxAssistantMessage("ack");
	}
}

function defaultChildReply(id: string, last: Message): AssistantMessage {
	if (last.role === "toolResult") {return fauxAssistantMessage(`${id} finished`);}
	const correlation = CORRELATION.exec(lastTextOf(last))?.[1];
	if (correlation) {
		return fauxAssistantMessage(
			[fauxToolCall("respond", { correlationId: correlation, message: `${id} answers: the build is green and all checks pass` })],
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(`${id} completed the task`);
}

function calls(...items: [name: string, args: Record<string, unknown>][]): AssistantMessage {
	return fauxAssistantMessage(items.map(([name, args]) => fauxToolCall(name, args as never)), { stopReason: "toolUse" });
}

// ---------------------------------------------------------------------------
// Root harness
// ---------------------------------------------------------------------------

const FAUX_HOOK = "__subagentRoundtripFaux";

type Workspace = { root: string; agentDir: string; cwd: string; sessionDir: string };

type ChildRecording = { path: AgentPath; session: BorrowedAgentSession; recorder: LiveRecorder };

class RootHarness {
	readonly children = new Map<string, ChildRecording>();
	private readonly attached = new Map<string, () => void>();
	private readonly attaching = new Set<string>();
	private readonly leases: SubagentLease[] = [];
	private readonly unsubscribers: (() => void)[] = [];

	private constructor(
		readonly runtime: AgentSessionRuntime,
		readonly provider: SubagentPresentationProvider,
		readonly recorder: LiveRecorder,
	) {}

	static async open(workspace: Workspace, model: ScriptedModel, sessionManager: SessionManager, reason: "startup" | "resume"): Promise<RootHarness> {
		const eventBus = createEventBus();
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			const services = await createAgentSessionServices({
				cwd: options.cwd,
				agentDir: options.agentDir,
				settingsManager: SettingsManager.create(options.cwd, options.agentDir),
				resourceLoaderOptions: {
					eventBus,
					extensionFactories: [
						{ name: "subagents", factory: createSubagentsExtension({ kind: "root" }) },
						{ name: "boundary-fixture", factory: boundaryFixture },
					],
				},
			});
			const result = await createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent });
			return { ...result, services, diagnostics: services.diagnostics };
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: workspace.cwd,
			agentDir: workspace.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason },
		});
		const discovery = discoverProvider(eventBus);
		const providerReady = new Promise<SubagentPresentationProvider>((resolve) => {
			if (discovery.provider) {resolve(discovery.provider);}
			discovery.subscribe((provider) => provider && resolve(provider));
		});
		const session = runtime.session;
		const pending: AgentSessionEvent[] = [];
		let deliver = (event: AgentSessionEvent): void => {
			pending.push(event);
		};
		const unsubscribeRoot = session.subscribe((event) => deliver(event));
		const entriesBeforeStart = session.sessionManager.getEntries();
		await session.bindExtensions({ mode: "print" });
		const provider = await providerReady;
		discovery.close();
		const recorder = new LiveRecorder(provider.presenters, [], entriesBeforeStart);
		const harness = new RootHarness(runtime, provider, recorder);
		harness.unsubscribers.push(unsubscribeRoot);
		for (const event of pending) {recorder.handle(event);}
		deliver = (event) => recorder.handle(event);
		model.attached = (id) => harness.attachedTo(id);
		harness.unsubscribers.push(provider.subscribe((event) => {
			if (event.kind === "node_added") {void harness.attach(event.node.path, event.node.incarnation);}
		}));
		for (const node of provider.snapshot().nodes) {void harness.attach(node.path, node.incarnation);}
		return harness;
	}

	get session() {
		return this.runtime.session;
	}

	get presenters(): SubagentPresenters {
		return this.provider.presenters;
	}

	/** Resolves once the harness records the child's current session. */
	attachedTo(id: string): Promise<void> {
		if (!this.attaching.has(id)) {return Promise.resolve();}
		return new Promise((resolve) => {
			this.attached.set(id, resolve);
		});
	}

	private async attach(agentPath: AgentPath, incarnation: string): Promise<void> {
		const id = agentPath.join("/");
		this.attaching.add(id);
		const lease = await this.provider.acquire({ path: agentPath, incarnation });
		this.leases.push(lease);
		const session = lease.session;
		const existing = this.children.get(id);
		const recorder = existing?.session.sessionId === session.sessionId
			? existing.recorder
			: new LiveRecorder(this.presenters, agentPath, session.sessionManager.getEntries());
		this.unsubscribers.push(session.subscribe((event) => recorder.handle(event)));
		this.children.set(id, { path: agentPath, session, recorder });
		this.attaching.delete(id);
		this.attached.get(id)?.();
		this.attached.delete(id);
	}

	async step(name: string): Promise<void> {
		await this.session.prompt(`step:${name}`);
	}

	/** Waits until the root and every child stop running and stay stopped. */
	async quiesce(timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let stable = 0;
		while (stable < 10) {
			if (Date.now() > deadline) {throw new Error("Sessions did not settle");}
			await sleep(20);
			const busy = this.session.isStreaming
				|| this.provider.snapshot().nodes.some((node) => node.state === "running" || node.state === "waiting")
				|| [...this.children.values()].some((child) => safeStreaming(child.session));
			stable = busy ? 0 : stable + 1;
		}
	}

	async dispose(): Promise<void> {
		for (const unsubscribe of this.unsubscribers) {unsubscribe();}
		for (const lease of this.leases) {lease.release();}
		await this.runtime.dispose();
	}
}

function safeStreaming(session: BorrowedAgentSession): boolean {
	try {
		return session.isStreaming;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Every live card has a saved counterpart with an equal reloaded card. */
function expectParity(live: Map<string, unknown>, reloaded: Map<string, unknown>): void {
	expect([...live.keys()].filter((key) => !reloaded.has(key))).toEqual([]);
	for (const [key, card] of live) {
		expect.soft(card, key).toBeDefined();
		expect.soft(reloaded.get(key), key).toEqual(card);
	}
}

function expectNoCorrelationIds(...maps: Map<string, unknown>[]): void {
	for (const map of maps) {
		for (const [key, card] of map) {expect(JSON.stringify(card ?? null), key).not.toMatch(/corr-/);}
	}
}

/** Root parity: every saved card has a live card and both are equal. */
function expectRootParity(harness: RootHarness): void {
	const reloaded = reloadCards(harness.presenters, [], harness.session.sessionManager.getEntries());
	expect([...harness.recorder.cards.keys()].toSorted()).toEqual([...reloaded.keys()].toSorted());
	expectParity(harness.recorder.cards, reloaded);
	expectNoCorrelationIds(harness.recorder.cards, harness.recorder.history, reloaded);
}

/** Child parity, read from the child's session file the way a reopened view reads it. */
function expectChildParity(harness: RootHarness): void {
	for (const child of harness.children.values()) {
		const file = child.session.sessionFile;
		if (!file) {continue;}
		const reloaded = reloadCards(harness.presenters, child.path, SessionManager.open(file).getEntries());
		expectParity(child.recorder.cards, reloaded);
		expectNoCorrelationIds(child.recorder.cards, child.recorder.history, reloaded);
	}
}

function cardsOf(cards: Map<string, unknown>, kind?: string): SubagentPresentation[] {
	return [...cards.values()]
		.flatMap((card) => (Array.isArray(card) ? card : card ? [card] : []) as SubagentPresentation[])
		.filter((card) => kind === undefined || card.kind === kind);
}

function lastCallId(harness: RootHarness, toolName: string): string | undefined {
	return harness.session.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") {return [];}
		return entry.message.content.flatMap((part) => (part.type === "toolCall" && part.name === toolName ? [part.id] : []));
	}).at(-1);
}

function toolCard(harness: RootHarness, toolName: string): SubagentPresentation | undefined {
	const card = harness.recorder.cards.get(`tool:${lastCallId(harness, toolName)}`);
	return Array.isArray(card) ? undefined : card;
}

function historyOf(harness: RootHarness, toolName: string): SubagentPresentation[] {
	return (harness.recorder.history.get(`tool:${lastCallId(harness, toolName)}`) ?? []).filter((card) => card !== undefined);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {throw new Error("Condition not reached");}
		await sleep(10);
	}
}

type Gate = { promise: Promise<void>; resolve: () => void };

function deferred(): Gate {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const model = new ScriptedModel();
let faux: FauxProviderHandle;
let workspace: Workspace;
let previousAgentDir: string | undefined;
let harness: RootHarness | undefined;
/** While set, the parent's run preparation pauses in `before_agent_start` until it resolves. */
let preparationGate: Gate | undefined;
let preparationReached: Gate | undefined;
let compaction: { entered: Gate; release: Gate } | undefined;
let rejectCompletionTrigger = false;
let rewriteCompletionTrigger = false;
let rewriteAwait = false;

function boundaryFixture(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		if (rejectCompletionTrigger && event.messageType === "custom" && event.message.customType === "subagents") {
			rejectCompletionTrigger = false;
			// Pi rejects the run during prompt preparation, before agent_start.
			Reflect.set(event.systemPromptOptions, "selectedTools", null);
		}
		if (rewriteCompletionTrigger && event.messageType === "custom" && event.message.customType === "subagents") {
			event.message.content = "replacement notice";
		}
		if (!preparationGate) {return;}
		preparationReached?.resolve();
		await preparationGate.promise;
	});
	pi.on("session_before_compact", async ({ preparation }) => {
		if (!compaction) {return;}
		compaction.entered.resolve();
		await compaction.release.promise;
		return { compaction: { summary: "Summary", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore } };
	});
	pi.on("tool_result", (event) => rewriteAwait && event.toolName === "await_agents"
		? { content: [{ type: "text", text: "replacement content" }] }
		: undefined);
}

function newWorkspace(): Workspace {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-roundtrip-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "faux", defaultModel: "faux-1", compaction: { enabled: false, keepRecentTokens: 1 },
	}));
	fs.writeFileSync(path.join(agentDir, "extensions", "faux.ts"), `export default function (pi) { globalThis.${FAUX_HOOK}(pi); }\n`);
	return { root, agentDir, cwd, sessionDir };
}

beforeAll(() => {
	faux = fauxProvider();
	(globalThis as Record<string, unknown>)[FAUX_HOOK] = (pi: ExtensionAPI) => pi.registerProvider(faux.provider);
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterAll(() => {
	delete (globalThis as Record<string, unknown>)[FAUX_HOOK];
	if (previousAgentDir === undefined) {delete process.env.PI_CODING_AGENT_DIR;}
	else {process.env.PI_CODING_AGENT_DIR = previousAgentDir;}
});

async function start(): Promise<RootHarness> {
	workspace = newWorkspace();
	process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
	model.reset();
	faux.setResponses(Array.from({ length: 500 }, () => (context: TranscriptContext, options: SimpleStreamOptions | undefined) => model.reply(context, options)));
	harness = await RootHarness.open(workspace, model, SessionManager.create(workspace.cwd, workspace.sessionDir), "startup");
	return harness;
}

afterEach(async () => {
	compaction?.release.resolve();
	compaction = undefined;
	rejectCompletionTrigger = false;
	rewriteCompletionTrigger = false;
	rewriteAwait = false;
	await harness?.dispose();
	harness = undefined;
	if (workspace) {fs.rmSync(workspace.root, { recursive: true, force: true });}
});

const SPAWN_WORKER = (): AssistantMessage => calls(["subagent", { agents: [{ id: "worker", task: "check the build" }] }]);

async function startWithWorker(): Promise<RootHarness> {
	const root = await start();
	model.steps.set("spawn", SPAWN_WORKER);
	await root.step("spawn");
	await root.quiesce();
	return root;
}

describe("subagent presenters round trip", () => {
	it("keeps a spawn and its child completion notice equal live and reloaded", async () => {
		const root = await startWithWorker();

		expect(toolCard(root, "subagent")).toMatchObject({ kind: "delegation", state: "complete" });
		expect(cardsOf(root.recorder.cards, "completion")).toEqual([
			expect.objectContaining({ state: "complete", data: expect.objectContaining({ result: expect.objectContaining({ path: ["worker"], state: "idle" }) }) }),
		]);
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps a fork equal live and reloaded", async () => {
		const root = await start();
		model.steps.set("fork", () => calls(["fork", { id: "explorer", task: "explore the side quest" }]));
		await root.step("fork");
		await root.quiesce();

		expect(toolCard(root, "fork")).toMatchObject({ kind: "delegation", state: "complete", data: { parameters: { fork: true } } });
		expect(cardsOf(root.recorder.cards, "completion")).toHaveLength(1);
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps a fire-and-forget send equal live and reloaded", async () => {
		const root = await startWithWorker();
		model.steps.set("tell", () => calls(["send", { to: "worker", message: "rebase onto main" }]));
		await root.step("tell");
		await root.quiesce();

		expect(toolCard(root, "send")).toMatchObject({ state: "complete", data: { result: { phase: "complete" } } });
		const worker = root.children.get("worker");
		expect(cardsOf(worker?.recorder.cards ?? new Map(), "message_received")).toEqual([
			expect.objectContaining({ path: ["worker"], data: expect.objectContaining({ parameters: { from: [], message: "rebase onto main", expectResponse: false } }) }),
		]);
		expectRootParity(root);
		expectChildParity(root);
	});

	it("streams a blocking send answered by respond and keeps it equal live and reloaded", async () => {
		const root = await startWithWorker();
		const gate = deferred();
		model.gates.set("worker", gate.promise);
		model.steps.set("ask", () => calls(["send", { to: "worker", message: "is the build green?", expectResponse: true }]));
		const asked = root.step("ask");
		await waitFor(() => (toolCard(root, "send")?.data.result as { phase?: string } | undefined)?.phase === "waiting");
		const progress = root.presenters.runningToolProgress({ sessionId: root.session.sessionId, toolCallId: lastCallId(root, "send") ?? "" });
		expect(progress).toMatchObject({ subagent: { kind: "send", data: { result: { phase: "waiting" } } } });
		expect(JSON.stringify(progress)).not.toMatch(/corr-/);
		gate.resolve();
		await asked;
		await root.quiesce();

		const phases = historyOf(root, "send").map((card) => (card.data.result as { phase?: string }).phase);
		expect(phases).toEqual(expect.arrayContaining(["sending", "waiting", "responding", "complete"]));
		const responding = historyOf(root, "send").filter((card) => (card.data.result as { phase?: string }).phase === "responding");
		expect(responding.at(0)?.state).toBe("active");
		expect(toolCard(root, "send")).toMatchObject({
			state: "complete",
			data: { result: { phase: "complete", response: "worker answers: the build is green and all checks pass" } },
		});
		expect(root.presenters.runningToolProgress({ sessionId: root.session.sessionId, toolCallId: lastCallId(root, "send") ?? "" })).toBeUndefined();
		const worker = root.children.get("worker");
		expect(cardsOf(worker?.recorder.cards ?? new Map(), "respond")).toEqual([
			expect.objectContaining({ state: "complete", data: expect.objectContaining({ parameters: { to: [], message: "worker answers: the build is green and all checks pass" } }) }),
		]);
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps an await that settles equal live and reloaded", async () => {
		const root = await start();
		const gate = deferred();
		model.gates.set("worker", gate.promise);
		model.steps.set("spawn", SPAWN_WORKER);
		model.steps.set("wait", () => calls(["await_agents", { agents: ["worker"] }]));
		await root.step("spawn");
		const waited = root.step("wait");
		await waitFor(() => toolCard(root, "await_agents")?.state === "active"
			&& (toolCard(root, "await_agents")?.data.result as { statuses?: unknown[] } | undefined)?.statuses?.length === 1);
		gate.resolve();
		await waited;
		await root.quiesce();

		expect(historyOf(root, "await_agents").some((card) =>
			card.state === "active" && JSON.stringify(card.data.result).includes('"state":"running"'))).toBe(true);
		expect(toolCard(root, "await_agents")).toMatchObject({
			state: "complete",
			data: { result: { statuses: [expect.objectContaining({ path: ["worker"], state: "idle", output: "worker completed the task" })] } },
		});
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps an interrupt equal live and reloaded", async () => {
		const root = await start();
		model.childScripts.set("worker", ({ last, signal }) => (last.role === "user"
			? untilAborted(signal).then(() => fauxAssistantMessage("stopped"))
			: undefined));
		model.steps.set("spawn", SPAWN_WORKER);
		model.steps.set("halt", () => calls(["interrupt", { agents: ["worker"] }]));
		await root.step("spawn");
		await root.step("halt");
		await root.quiesce();

		expect(toolCard(root, "interrupt")).toMatchObject({ state: "complete", data: { result: { interrupted: [{ path: ["worker"] }] } } });
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps a teardown equal live and reloaded", async () => {
		const root = await startWithWorker();
		model.steps.set("remove", () => calls(["teardown", { agent: "worker" }]));
		await root.step("remove");
		await root.quiesce();

		expect(toolCard(root, "teardown")).toMatchObject({
			state: "complete",
			data: { parameters: { agent: "worker", source: "model" }, result: { affectedAgents: [expect.objectContaining({ path: ["worker"] })] } },
		});
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps a resurrection equal live and reloaded", async () => {
		const root = await startWithWorker();
		model.steps.set("remove", () => calls(["teardown", { agent: "worker" }]));
		await root.step("remove");
		await root.quiesce();
		const removed = toolCard(root, "teardown")?.data.result as { affectedAgents: { sessionId: string }[] };
		const sessionId = removed.affectedAgents[0]?.sessionId;
		model.steps.set("revive", () => calls(["resurrect", { agents: [{ id: "worker", sessionId, task: "resume the check", channels: [] }] }]));
		await root.step("revive");
		await root.quiesce();

		expect(toolCard(root, "resurrect")).toMatchObject({
			state: "complete",
			data: { parameters: { source: "model" }, result: { affectedAgents: [expect.objectContaining({ path: ["worker"], sessionId })] } },
		});
		expect(cardsOf(root.recorder.cards, "completion")).toHaveLength(2);
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps a blocking send aborted by the user equal live and reloaded", async () => {
		const root = await startWithWorker();
		const gate = deferred();
		model.gates.set("worker", gate.promise);
		model.steps.set("ask", () => calls(["send", { to: "worker", message: "is the build green?", expectResponse: true }]));
		const asked = root.step("ask");
		await waitFor(() => (toolCard(root, "send")?.data.result as { phase?: string } | undefined)?.phase === "waiting");
		await root.session.abort();
		await asked;
		expect(toolCard(root, "send")).toMatchObject({ kind: "send", state: "aborted" });
		gate.resolve();
		await root.quiesce();

		expect(cardsOf(root.recorder.cards, "message_received")).toEqual([
			expect.objectContaining({ data: expect.objectContaining({ parameters: expect.objectContaining({ from: ["worker"] }) }) }),
		]);
		expectRootParity(root);
		expectChildParity(root);
	});

	it("keeps a validation error equal live and reloaded", async () => {
		const root = await start();
		model.steps.set("invalid", () => calls(["send", { message: "no target" }]));
		await root.step("invalid");
		await root.quiesce();

		expect(toolCard(root, "send")).toMatchObject({ kind: "send", state: "error", data: { result: { error: expect.any(String) } } });
		expectRootParity(root);
	});

	it("keeps a call cut off by a model error equal live and reloaded", async () => {
		const root = await start();
		model.steps.set("broken", () => fauxAssistantMessage(
			[fauxToolCall("send", { to: "worker", message: "never delivered" })],
			{ stopReason: "error", errorMessage: "connection reset" },
		));
		await root.step("broken");
		await root.quiesce();

		expect(toolCard(root, "send")).toMatchObject({ kind: "send", state: "aborted" });
		expectRootParity(root);
	});

	it("keeps old and new cards equal after the parent session resumes", async () => {
		const first = await startWithWorker();
		const sessionFile = first.session.sessionFile;
		if (!sessionFile) {throw new Error("The root session has no file");}
		const before = new Map(first.recorder.cards);
		await first.dispose();
		harness = undefined;

		const root = await RootHarness.open(workspace, model, SessionManager.open(sessionFile, workspace.sessionDir), "resume");
		harness = root;
		await root.quiesce();
		model.steps.set("tell", () => calls(["send", { to: "worker", message: "rebase onto main" }]));
		await root.step("tell");
		await root.quiesce();

		expect(toolCard(root, "send")).toMatchObject({ state: "complete" });
		const reloaded = reloadCards(root.presenters, [], root.session.sessionManager.getEntries());
		expect([...before.keys(), ...root.recorder.cards.keys()].toSorted()).toEqual([...reloaded.keys()].toSorted());
		expectParity(before, reloaded);
		expectParity(root.recorder.cards, reloaded);
		expectNoCorrelationIds(before, root.recorder.cards, root.recorder.history, reloaded);
		expectChildParity(root);
	});
});

describe("settlement delivery across the pi seam", () => {
	it("delivers a released answer once, also after the parent session restores", async () => {
		const root = await start();
		const childGate = deferred();
		model.gates.set("worker", childGate.promise);
		model.steps.set("spawn", SPAWN_WORKER);
		await root.step("spawn");
		const worker = root.provider.snapshot().nodes[0];
		await root.provider.setHold({ path: worker.path, incarnation: worker.incarnation, held: true });
		childGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes[0]?.heldSettlement === "idle");
		await root.provider.setHold({ path: worker.path, incarnation: worker.incarnation, held: false });
		await root.quiesce();
		expect(cardsOf(root.recorder.cards, "completion")).toHaveLength(1);
		const sessionFile = root.session.sessionFile!;
		await root.dispose();
		harness = undefined;
		const restored = await RootHarness.open(workspace, model, SessionManager.open(sessionFile, workspace.sessionDir), "resume");
		harness = restored;
		await waitFor(() => restored.provider.snapshot().ready);
		await restored.quiesce();
		expect(cardsOf(reloadCards(restored.presenters, [], restored.session.sessionManager.getEntries()), "completion")).toHaveLength(1);
	});

	it("never puts a completion where clearing pi's queue during run preparation can drop it", async () => {
		const root = await start();
		const childGate = deferred();
		model.gates.set("worker", childGate.promise);
		model.steps.set("spawn", SPAWN_WORKER);
		await root.step("spawn");
		preparationGate = deferred();
		preparationReached = deferred();
		const user = root.session.prompt("new user prompt");
		try {
			await preparationReached.promise;
			childGate.resolve();
			await waitFor(() => root.provider.snapshot().nodes[0]?.state === "idle");
			await sleep(20);
			expect(root.session.agent.peekQueuedMessages()).toEqual([]);
			root.session.clearQueue();
		} finally {
			preparationGate.resolve();
			preparationGate = undefined;
			await user;
		}
		await root.quiesce();
		expect(cardsOf(root.recorder.cards, "completion")).toHaveLength(1);
	});

	it("removes an ancestor and its descendant torn down in the same tick", async () => {
		const root = await start();
		model.childScripts.set("worker", ({ last }) => last.role === "user" ? calls(["subagent", { agents: [{ id: "grand", task: "do it" }] }]) : undefined);
		model.steps.set("spawn", SPAWN_WORKER);
		await root.step("spawn");
		await root.quiesce();
		const worker = root.provider.snapshot().nodes.find((node) => node.path.join("/") === "worker")!;
		const grand = root.provider.snapshot().nodes.find((node) => node.path.join("/") === "worker/grand")!;
		expect(grand).toBeDefined();
		const status = await Promise.race([
			Promise.all([root.provider.teardown(worker), root.provider.teardown(grand)]).then(() => "removed"),
			sleep(2000).then(() => "stuck"),
		]);
		expect(status).toBe("removed");
		expect(root.provider.snapshot().nodes).toEqual([]);
	});

	it.each(["model", "user"] as const)("reports full paths for a %s teardown without consuming nested held answers", async (source) => {
		const root = await start();
		const directGate = deferred();
		const nestedGate = deferred();
		model.childScripts.set("worker", async ({ last }) => {
			if (lastTextOf(last) === "Task: check the build") {
				await directGate.promise;
				return calls(["subagent", { agents: [{ id: "worker", task: "inner check" }] }]);
			}
			if (lastTextOf(last) === "Task: inner check") {
				await nestedGate.promise;
				return fauxAssistantMessage("nested answer");
			}
			return fauxAssistantMessage("direct answer");
		});
		model.steps.set("spawn", SPAWN_WORKER);
		await root.step("spawn");
		const worker = root.provider.snapshot().nodes[0];
		await root.provider.setHold({ ...worker, held: true });
		directGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes.length === 2);
		const nested = root.provider.snapshot().nodes.find((node) => node.path.length === 2)!;
		await root.provider.setHold({ ...nested, held: true });
		nestedGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes.every((node) => node.heldSettlement === "idle"));
		if (source === "model") {
			model.steps.set("remove", () => calls(["teardown", { agent: "worker" }]));
			await root.step("remove");
		} else {
			await root.provider.teardown(worker);
		}
		const card = cardsOf(root.recorder.cards, "teardown").at(-1);
		expect(card).toMatchObject({ data: { parameters: { source }, result: { affectedAgents: [
			{ path: ["worker"], output: "direct answer" },
			{ path: ["worker", "worker"], output: "nested answer" },
		] } } });
		expect(root.provider.snapshot().nodes).toEqual([]);

		await root.provider.resurrect({ parentPath: [], localId: "worker", sessionId: worker.sessionId, task: "reopen", channels: [] });
		await waitFor(() => root.provider.snapshot().nodes.find((node) => node.path.length === 2)?.heldSettlement === "idle");
		const restored = root.provider.snapshot().nodes.find((node) => node.path.length === 2)!;
		expect(restored).toMatchObject({ path: ["worker", "worker"], held: true, heldSettlement: "idle" });
		await root.provider.setHold({ ...restored, held: false });
		await root.quiesce();
		const parentFile = root.children.get("worker")!.session.sessionFile!;
		const entries = SessionManager.open(parentFile).getBranch();
		const completions = cardsOf(reloadCards(root.presenters, ["worker"], entries), "completion");
		expect(completions).toHaveLength(1);
		expect(completions[0]).toMatchObject({ data: { result: { path: ["worker", "worker"], output: "nested answer" } } });
	});
});

type CrashPoint = "before offer" | "before native append" | "after native append" | "after cleanup";

/** The files a process restart would see at a settlement delivery checkpoint. */
type CrashImage = { transcript: Buffer; outbox: Buffer; branchBeforeReceipt?: string };

function hasReceipt(details: unknown): boolean {
	const ids = record(details)?.settlementReceipts;
	return Array.isArray(ids) && ids.length > 0;
}

async function captureDelivery(channel: "notice" | "await") {
	const root = await start();
	const childGate = deferred();
	model.gates.set("worker", childGate.promise);
	model.childScripts.set("worker", () => fauxAssistantMessage("recoverable answer"));
	model.steps.set("spawn", SPAWN_WORKER);
	await root.step("spawn");
	const worker = root.provider.snapshot().nodes[0];
	await root.provider.setHold({ ...worker, held: true });
	childGate.resolve();
	await waitFor(() => root.provider.snapshot().nodes[0]?.heldSettlement === "idle");

	const parentFile = root.session.sessionFile!;
	const outboxFile = getPersistencePaths(parentFile).logFile;
	const images = new Map<CrashPoint, CrashImage>();
	const sessionManager = root.session.sessionManager;
	let branchBeforeReceipt: string | undefined;
	const capture = (point: CrashPoint): void => {
		images.set(point, { transcript: fs.readFileSync(parentFile), outbox: fs.readFileSync(outboxFile), branchBeforeReceipt });
	};
	const unsubscribe = root.provider.subscribe((event) => {
		if (event.kind === "node_updated" && event.node.incarnation === worker.incarnation && !event.node.held && !images.has("before offer")) {
			capture("before offer");
		}
	});
	const native = root.session.subscribe((event) => {
		if (event.type !== "message_end") {return;}
		const message = record(event.message);
		if (!hasReceipt(message?.details)) {return;}
		branchBeforeReceipt = sessionManager.getBranch().at(-1)?.id;
		capture("before native append");
	});
	const appendCustom = sessionManager.appendCustomMessageEntry.bind(sessionManager);
	const customSpy = vi.spyOn(sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
		const id = appendCustom(...args);
		if (hasReceipt(args[3])) {capture("after native append");}
		return id;
	});
	const appendMessage = sessionManager.appendMessage.bind(sessionManager);
	const messageSpy = vi.spyOn(sessionManager, "appendMessage").mockImplementation((message) => {
		const id = appendMessage(message);
		if (message.role === "toolResult" && hasReceipt(message.details)) {capture("after native append");}
		return id;
	});
	try {
		if (channel === "await") {
			model.steps.set("await-answer", () => calls(["await_agents", { agents: ["worker"] }]));
			const run = root.step("await-answer");
			await waitFor(() => [...root.recorder.history.values()].some((history) =>
				history.some((card) => card?.kind === "await" && card.data.operation === "await" && card.data.result.statuses.some((status) => status.state === "held"))));
			await root.provider.setHold({ ...worker, held: false });
			await run;
		} else {
			await root.provider.setHold({ ...worker, held: false });
		}
		await root.quiesce();
		capture("after cleanup");
	} finally {
		unsubscribe();
		native();
		customSpy.mockRestore();
		messageSpy.mockRestore();
		await root.dispose();
		harness = undefined;
	}
	return { parentFile, outboxFile, images };
}

function committedAnswers(entries: readonly SessionEntry[]): string[] {
	return entries.flatMap((entry) => {
		if (entry.type === "custom_message" && entry.customType === "subagents" && hasReceipt(entry.details)) {return [textOf(entry.content)];}
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "await_agents" && !entry.message.isError && hasReceipt(entry.message.details)) {
			return [textOf(entry.message.content)];
		}
		return [];
	});
}

describe("settlement receipt recovery", () => {
	it.each(["notice", "await"] as const)("recovers a %s across every durable delivery checkpoint", async (channel) => {
		const { parentFile, outboxFile, images } = await captureDelivery(channel);
		const points = ["before offer", "before native append", "after native append", "after cleanup"] as const;
		for (const point of points) {
			const image = images.get(point);
			expect(image, point).toBeDefined();
			if (!image) {continue;}
			fs.writeFileSync(parentFile, image.transcript);
			fs.writeFileSync(outboxFile, image.outbox);
			const manager = SessionManager.open(parentFile, workspace.sessionDir);
			const saved = loadPersistedAgents(parentFile)?.agents[0]?.hold;
			const ids = saved?.pending.map((entry) => entry.id) ?? [];
			const committed = point === "after native append" || point === "after cleanup";
			expect(committedAnswers(manager.getBranch()), point).toHaveLength(committed ? 1 : 0);
			expect(ids, point).toHaveLength(point === "after cleanup" ? 0 : 1);
			if (point === "after native append") {
				expect(settlementReceipts(manager.getBranch()).settlements).toEqual(new Set(ids));
			}
			const fresh = await RootHarness.open(workspace, model, manager, "resume");
			harness = fresh;
			await fresh.quiesce();
			const answers = committedAnswers(fresh.session.sessionManager.getBranch());
			expect(answers, point).toHaveLength(1);
			expect(answers[0], point).toContain("recoverable answer");
			expect(loadPersistedAgents(parentFile)?.agents[0]?.hold?.pending, point).toEqual([]);
			await fresh.dispose();
			harness = undefined;
		}
	});

	it("does not acknowledge a receipt on a different branch", async () => {
		const { parentFile, outboxFile, images } = await captureDelivery("notice");
		const image = images.get("after native append")!;
		fs.writeFileSync(parentFile, image.transcript);
		fs.writeFileSync(outboxFile, image.outbox);
		const manager = SessionManager.open(parentFile, workspace.sessionDir);
		manager.branch(image.branchBeforeReceipt!);
		expect(committedAnswers(manager.getEntries())).toHaveLength(1);
		expect(committedAnswers(manager.getBranch())).toEqual([]);
		const fresh = await RootHarness.open(workspace, model, manager, "resume");
		harness = fresh;
		await fresh.quiesce();
		const answers = committedAnswers(fresh.session.sessionManager.getBranch());
		expect(answers).toHaveLength(1);
		expect(answers[0]).toContain("recoverable answer");
	});
});

describe("settlement delivery at Pi boundaries", () => {
	it("delivers later completions after a notice appends during manual compaction", async () => {
		const root = await start();
		const firstGate = deferred();
		const secondGate = deferred();
		model.gates.set("first", firstGate.promise);
		model.gates.set("second", secondGate.promise);
		model.steps.set("spawn", () => calls(["subagent", { agents: [{ id: "first", task: "first task" }, { id: "second", task: "second task" }] }]));
		await root.step("prime");
		await root.step("spawn");
		const { entered, release } = compaction = { entered: deferred(), release: deferred() };
		const compact = root.session.compact();
		try {
			await Promise.race([entered.promise, compact.then(() => {throw new Error("Compaction did not reach the gate");})]);
			firstGate.resolve();
			await waitFor(() => committedAnswers(root.session.sessionManager.getBranch()).some((text) => text.includes("first completed")));
		} finally {
			release.resolve();
			compaction = undefined;
			await compact;
		}
		secondGate.resolve();
		await root.quiesce();
		const answers = committedAnswers(root.session.sessionManager.getBranch());
		expect(answers.filter((text) => text.includes("first completed"))).toHaveLength(1);
		expect(answers.filter((text) => text.includes("second completed"))).toHaveLength(1);
	});

	it("retries a rejected completion trigger in the next healthy run", async () => {
		const root = await start();
		const childGate = deferred();
		model.gates.set("worker", childGate.promise);
		model.steps.set("spawn", SPAWN_WORKER);
		await root.step("spawn");
		const worker = root.provider.snapshot().nodes[0];
		await root.provider.setHold({ ...worker, held: true });
		childGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes[0]?.heldSettlement === "idle");
		let failed = false;
		const unsubscribe = root.session.extensionRunner.onError((error) => {
			if (error.event === "send_message") {failed = true;}
		});
		try {
			rejectCompletionTrigger = true;
			await root.provider.setHold({ ...worker, held: false });
			await waitFor(() => failed);
		} finally {
			unsubscribe();
		}
		expect(committedAnswers(root.session.sessionManager.getBranch())).toEqual([]);
		await root.step("recovery");
		await root.quiesce();
		const answers = committedAnswers(root.session.sessionManager.getBranch());
		expect(answers).toHaveLength(1);
		expect(answers[0]).toContain("worker completed the task");
		expect(loadPersistedAgents(root.session.sessionFile!)?.agents[0]?.hold?.pending).toEqual([]);
	});

	it("retries a rewritten completion as context in the same run", async () => {
		const root = await start();
		const childGate = deferred();
		model.gates.set("worker", childGate.promise);
		model.steps.set("spawn", SPAWN_WORKER);
		await root.step("spawn");
		const worker = root.provider.snapshot().nodes[0];
		await root.provider.setHold({ ...worker, held: true });
		childGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes[0]?.heldSettlement === "idle");
		rewriteCompletionTrigger = true;
		await root.provider.setHold({ ...worker, held: false });
		await root.quiesce();
		const answers = committedAnswers(root.session.sessionManager.getBranch());
		expect(answers).toHaveLength(2);
		expect(answers[0]).toBe("replacement notice");
		expect(answers[1]).toContain("worker completed the task");
		expect(loadPersistedAgents(root.session.sessionFile!)?.agents[0]?.hold?.pending).toEqual([]);
	});

	it.each(["unchanged", "rewritten"] as const)("settles an %s await only after the parent sees the answer", async (mode) => {
		const root = await start();
		const childGate = deferred();
		model.gates.set("worker", childGate.promise);
		model.steps.set("spawn", SPAWN_WORKER);
		await root.step("spawn");
		const worker = root.provider.snapshot().nodes[0];
		await root.provider.setHold({ ...worker, held: true });
		childGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes[0]?.heldSettlement === "idle");
		model.steps.set("await-answer", () => calls(["await_agents", { agents: ["worker"] }]));
		rewriteAwait = mode === "rewritten";
		const run = root.step("await-answer");
		await waitFor(() => [...root.recorder.history.values()].some((history) => history.some((card) =>
			card?.kind === "await" && card.data.operation === "await" && card.data.result.statuses.some((status) => status.state === "held"))));
		await root.provider.setHold({ ...worker, held: false });
		await run;
		await root.quiesce();
		const branch = root.session.sessionManager.getBranch();
		const awaitTexts = branch.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "await_agents"
			? [textOf(entry.message.content)] : []);
		const notices = branch.flatMap((entry) => entry.type === "custom_message" && entry.customType === "subagents" && hasReceipt(entry.details)
			? [textOf(entry.content)] : []);
		expect(awaitTexts).toHaveLength(1);
		if (mode === "rewritten") {
			expect(awaitTexts).toEqual(["replacement content"]);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("worker completed the task");
		} else {
			expect(awaitTexts[0]).toContain("worker completed the task");
			expect(notices).toEqual([]);
		}
		expect(loadPersistedAgents(root.session.sessionFile!)?.agents[0]?.hold?.pending).toEqual([]);
	});
});

describe("settlement claims across the pi seam", () => {
it("reports a released replacement through a wait that claims its queued notice, with the note", async () => {
	const root = await start();
	const childGate = deferred();
	model.gates.set("worker", childGate.promise);
	model.steps.set("spawn", SPAWN_WORKER);
	await root.step("spawn");
	const worker = root.provider.snapshot().nodes[0];
	await root.provider.setHold({ path: worker.path, incarnation: worker.incarnation, held: true });
	childGate.resolve();
	await waitFor(() => root.provider.snapshot().nodes[0]?.heldSettlement === "idle");
	model.childScripts.set("worker", () => fauxAssistantMessage("replacement answer"));
	model.steps.set("restart", () => calls(["send", { to: "worker", message: "try again" }]));
	await root.step("restart");
	await waitFor(() => root.provider.snapshot().nodes[0]?.heldSettlement === "idle");
	const awaitGate = deferred();
	const awaitEntered = deferred();
	model.steps.set("await", async () => {
		awaitEntered.resolve();
		await awaitGate.promise;
		return calls(["await_agents", { agents: ["worker"] }]);
	});
	const run = root.step("await");
	await awaitEntered.promise;
	try {
		await root.provider.setHold({ path: worker.path, incarnation: worker.incarnation, held: false });
	} finally {
		awaitGate.resolve();
		await run;
	}
	const card = toolCard(root, "await_agents");
	expect(card).toMatchObject({ data: { result: { statuses: [{ output: "replacement answer", replacedHeldResult: true }] } } });
	expect(cardsOf(root.recorder.cards, "completion")).toHaveLength(0);
});

it("holds a settled answer that is still queued for a running parent", async () => {
	const root = await start();
	const childGate = deferred();
	model.gates.set("worker", childGate.promise);
	model.steps.set("spawn", SPAWN_WORKER);
	await root.step("spawn");
	const worker = root.provider.snapshot().nodes[0];
	const rootGate = deferred();
	const rootEntered = deferred();
	model.steps.set("busy", async () => {
		rootEntered.resolve();
		await rootGate.promise;
		return fauxAssistantMessage("root done");
	});
	const run = root.step("busy");
	await rootEntered.promise;
	try {
		childGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes[0]?.state === "idle");
		await root.provider.setHold({ path: worker.path, incarnation: worker.incarnation, held: true });
	} finally {
		rootGate.resolve();
		await run;
	}
	await root.quiesce();
	expect(cardsOf(root.recorder.cards, "completion")).toHaveLength(0);
	expect(root.provider.snapshot().nodes[0]).toMatchObject({ held: true, heldSettlement: "idle" });
});

it("keeps a queued completion when a parallel await is rejected", async () => {
	const root = await start();
	const firstGate = deferred();
	const secondGate = deferred();
	model.gates.set("first", firstGate.promise);
	model.gates.set("second", secondGate.promise);
	model.steps.set("spawn-two", () => calls(["subagent", { agents: [{ id: "first", task: "first" }, { id: "second", task: "second" }] }]));
	await root.step("spawn-two");
	const rootGate = deferred();
	const rootEntered = deferred();
	model.steps.set("wait-two", async () => {
		rootEntered.resolve();
		await rootGate.promise;
		return calls(["await_agents", { agents: ["first"] }], ["await_agents", { agents: ["second"] }]);
	});
	const run = root.step("wait-two");
	await rootEntered.promise;
	try {
		secondGate.resolve();
		await waitFor(() => root.provider.snapshot().nodes.find((node) => node.path[0] === "second")?.state === "idle");
		rootGate.resolve();
		await waitFor(() => root.recorder.cards.size >= 3);
		await sleep(30);
	} finally {
		rootGate.resolve();
		firstGate.resolve();
		await run;
	}
	await root.quiesce();
	const waitCards = cardsOf(root.recorder.cards, "await");
	expect(waitCards.find((card) => card.state === "error")).toMatchObject({ data: { result: { error: "Another await_agents call is already active." } } });
	expect(cardsOf(root.recorder.cards, "completion").map((card) => card.data.operation === "completion" ? card.data.result.path : [])).toContainEqual(["second"]);
});

it("does not report a stop for a run the stop never cancelled", async () => {
	const root = await startWithWorker();
	let stop: Promise<void> | undefined;
	const unsub = root.provider.subscribe((event) => {
		if (event.kind === "node_updated" && event.node.path[0] === "worker" && event.node.state === "running" && !stop) {
			stop = root.provider.stop({ path: event.node.path, incarnation: event.node.incarnation, expectedSessionId: event.node.sessionId });
		}
	});
	model.childScripts.set("worker", () => fauxAssistantMessage("real un-aborted response"));
	model.steps.set("restart", () => calls(["send", { to: "worker", message: "try again" }]));
	try {
		await root.step("restart");
		await stop;
		await root.quiesce();
	} finally {
		unsub();
	}
	expect(stop).toBeDefined();
	expect(cardsOf(root.recorder.cards, "completion")).toHaveLength(2);
	model.steps.set("await", () => calls(["await_agents", { agents: ["worker"] }]));
	await root.step("await");
	expect(toolCard(root, "await_agents")).toMatchObject({ data: { result: { statuses: [{ state: "idle", output: "real un-aborted response" }] } } });
});
});
