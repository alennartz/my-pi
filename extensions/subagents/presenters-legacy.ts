/**
 * Saved-session shapes from earlier my-pi versions.
 *
 * Earlier versions saved operations in `details.subagentContent` and wrote
 * structured tool results such as `{ agents, interrupted }`. These readers map
 * each shape to a candidate card in the current shape. The caller validates
 * every candidate and drops the ones that fail.
 */
import type { AgentPath, SubagentMessageInput, SubagentToolCallInput } from "@pimote/sdk/subagents";
import { asRecord } from "./narrow.js";

type Json = Readonly<Record<string, unknown>>;
type CardState = "complete" | "error" | "aborted";
/** A card in the current shape that still needs validation. */
export type LegacyCard = Readonly<{ kind: string; state: CardState; data: Json }>;
type Candidate = LegacyCard;
type DelegationParameters = Readonly<{ agents: Json[]; fork: boolean }>;

type Context = Readonly<{
	owner: AgentPath;
	state: CardState;
	toolName?: string;
	toolCallId?: string;
	/** Tool call arguments. Empty for custom messages. */
	args: Json;
	/** Result text of a failed tool call. */
	failure?: string;
	facts: readonly Json[];
}>;

const OUTCOMES: ReadonlySet<string> = new Set(["running", "waiting", "idle", "errored", "dead", "stopped", "held", "removed"]);
const SETTLED: ReadonlySet<string> = new Set(["idle", "errored", "dead", "stopped"]);
const AWAIT_MESSAGE_ERROR = "Cannot wait: requested agents must receive your response before settling.";

/** The candidate card a legacy tool result holds, or undefined when it holds none. */
export function legacyToolCard(input: SubagentToolCallInput): LegacyCard | undefined {
	const execution = input.execution;
	if (execution.state !== "complete" && execution.state !== "error") {return undefined;}
	const details = asRecord(execution.details);
	if (!details) {return undefined;}
	const context: Context = {
		owner: input.ownerPath,
		state: execution.state,
		toolName: input.toolName,
		toolCallId: input.toolCallId,
		args: asRecord(input.args) ?? {},
		failure: execution.state === "error" ? stringValue(execution.text) : undefined,
		facts: factList(details.semantic),
	};
	const item = contentItems(details).find((entry) => entry.source === "tool" && asRecord(entry.placement)?.toolCallId === input.toolCallId);
	return item ? toolItemCard(item, context) : structuredCard(details, context);
}

/** The candidate cards a legacy `subagents` custom message holds, in order. */
export function legacyMessageCards(input: SubagentMessageInput): LegacyCard[] {
	const details = asRecord(input.details);
	if (!details) {return [];}
	const context: Context = { owner: input.ownerPath, state: "complete", args: {}, facts: factList(details.semanticEvents) };
	const content = stringValue(input.content) ?? "";
	const idleTags = tagAttributes(content, "agent_idle");
	const messageTags = tagAttributes(content, "agent_message");
	let idleIndex = 0;
	let messageIndex = 0;
	return contentItems(details)
		.filter((item) => item.source === "custom_entry")
		.flatMap((item) => {
			const data = asRecord(item.data);
			if (!data) {return [];}
			const state = itemState(item.state) ?? "complete";
			const operationId = stringValue(item.operationId) ?? "";
			if (data.operation === "completion") {return [completionCard(data, state, context, operationId, idleTags[idleIndex++])];}
			if (data.operation === "send") {
				if (isIncoming(item, data)) {
					const card = receivedCard(data, state, context, messageTags[messageIndex++]);
					return card ? [card] : [];
				}
				return [sendCard(data, state, context)];
			}
			const card = operationCard(data, state, { ...context, state }, [operationId], operationId.startsWith("control-"));
			return card ? [card] : [];
		});
}

// ---------------------------------------------------------------------------
// subagentContent items
// ---------------------------------------------------------------------------

function contentItems(details: Json): Json[] {
	const items = details.subagentContent;
	return Array.isArray(items) ? items.flatMap((item): Json[] => { const record = asRecord(item); return record ? [record] : []; }) : [];
}

function itemState(value: unknown): CardState | undefined {
	return value === "complete" || value === "error" || value === "aborted" ? value : undefined;
}

function toolItemCard(item: Json, context: Context): Candidate | undefined {
	const data = asRecord(item.data);
	if (!data) {return undefined;}
	const state = itemState(item.state) ?? context.state;
	if (data.operation === "send") {return sendCard(data, state, context);}
	const invocations = [stringValue(item.operationId), context.toolCallId].filter((id): id is string => id !== undefined);
	return operationCard(data, state, context, invocations, false);
}

function operationCard(data: Json, state: CardState, context: Context, invocations: readonly string[], userControl: boolean): Candidate | undefined {
	const parameters = asRecord(data.parameters) ?? {};
	const result = asRecord(data.result) ?? {};
	const error = failure(result, state, context);
	switch (data.operation) {
		case "respond":
			return card("respond", state, {
				parameters: { to: respondTarget(context), message: stringValue(context.args.message) ?? stringValue(parameters.message) ?? stringValue(data.body) ?? "" },
				result: { error },
			});
		case "await":
			return awaitCard(state, context, {
				agents: argumentNames(context, "agents") ?? pathNames(context.owner, parameters.agents) ?? pathNames(context.owner, data.requested),
				statuses: asRecord(data.result) ? result.statuses : data.statuses,
				interrupted: result.interrupted,
				error,
			}, invocations);
		case "delegation":
			return card("delegation", state, {
				parameters: delegationParameters(context, parameters),
				result: { children: delegatedChildren(context, result.children ?? data.children ?? result.agents), error },
			});
		case "interrupt":
			return interruptCard(state, context, argumentNames(context, "agents") ?? pathNames(context.owner, parameters.agents), result, error);
		case "teardown":
			return card("teardown", state, {
				parameters: {
					agent: stringValue(context.args.agent) ?? relativeName(context.owner, resolvePath(context.owner, parameters.agent)),
					source: userControl || parameters.source === "user" ? "user" : "model",
				},
				result: { affectedAgents: affectedAgents(context, result.affectedAgents ?? result.agents, "idle"), error },
			});
		case "resurrect":
			return card("resurrect", state, {
				parameters: {
					agents: resurrectItems(context.args.agents) ?? resurrectItems(parameters.agents) ?? [],
					source: userControl || parameters.source === "user" ? "user" : "model",
				},
				result: { affectedAgents: affectedAgents(context, result.affectedAgents ?? result.agents, "running"), error },
			});
		default:
			return undefined;
	}
}

/** A send the owner made: tool-backed, or a reply that arrived after the call ended. */
function sendCard(data: Json, state: CardState, context: Context): Candidate {
	const parameters = asRecord(data.parameters) ?? {};
	const result = asRecord(data.result) ?? {};
	const target = parameters.to ?? data.to ?? result.to;
	const deferredReply = context.toolName === undefined;
	return card("send", state, {
		parameters: {
			to: stringValue(context.args.to) ?? relativeName(context.owner, resolvePath(context.owner, target)) ?? "",
			message: stringValue(context.args.message) ?? stringValue(parameters.message) ?? stringValue(data.request) ?? stringValue(result.message) ?? "",
			expectResponse: deferredReply || context.args.expectResponse === true || parameters.expectResponse === true,
		},
		result: { phase: "complete", response: nonEmpty(result.response) ?? nonEmpty(data.response), error: failure(result, state, context) },
	});
}

/** A custom-entry send that delivered a message to the owner. */
function isIncoming(item: Json, data: Json): boolean {
	if (item.kind === "message_received") {return true;}
	const result = asRecord(data.result);
	if (result) {return Array.isArray(result.from);}
	return typeof data.request === "string";
}

function receivedCard(data: Json, state: CardState, context: Context, tag: Json | undefined): Candidate | undefined {
	const result = asRecord(data.result);
	const from = result ? resolvePath(context.owner, result.from) : resolvePath(context.owner, tag?.from);
	if (!from) {return undefined;}
	const expectResponse = result ? result.responseExpected === true : tag?.response_expected === "true";
	return card("message_received", state, {
		parameters: { from, message: stringValue(result?.message) ?? stringValue(data.request) ?? "", expectResponse },
		result: { error: stringValue(result?.error) },
	});
}

function completionCard(data: Json, state: CardState, context: Context, operationId: string, tag: Json | undefined): Candidate {
	const result = asRecord(data.result) ?? {};
	const identity = completionIdentity(operationId);
	const localId = stringValue(tag?.id);
	const path = identity?.path ?? (localId ? resolvePath(context.owner, localId) : undefined) ?? context.owner;
	const settled = stringValue(result.state) ?? stringValue(result.status);
	return card("completion", state, {
		parameters: {},
		result: {
			path,
			state: settled !== undefined && SETTLED.has(settled) ? settled : "idle",
			output: stringValue(result.output),
			error: stringValue(result.error),
			sessionId: stringValue(result.sessionId) ?? identity?.sessionId ?? stringValue(tag?.session_id),
			usage: usage(result.usage),
		},
	});
}

/** Completion operation ids read `completion:<JSON path>:<session id>:<sequence>`. */
function completionIdentity(operationId: string): { path: AgentPath; sessionId?: string } | undefined {
	const match = /^completion:(\[[^\]]*\]):([^:]*):/.exec(operationId);
	if (!match) {return undefined;}
	try {
		const path = resolvePath([], JSON.parse(match[1]) as unknown);
		return path ? { path, ...(match[2] ? { sessionId: match[2] } : undefined) } : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Structured tool results without subagentContent
// ---------------------------------------------------------------------------

function structuredCard(details: Json, context: Context): Candidate | undefined {
	const state = context.state;
	const error = failure(details, state, context);
	switch (context.toolName) {
		case "send":
			if (!("response" in details) && !("deferred" in details)) {return undefined;}
			return sendCard({ result: details }, state, context);
		case "respond": {
			const to = respondTarget(context);
			return to ? card("respond", state, { parameters: { to, message: stringValue(context.args.message) ?? "" }, result: { error } }) : undefined;
		}
		case "await_agents":
			if (!Array.isArray(details.agents)) {return undefined;}
			return awaitCard(state, context, {
				agents: argumentNames(context, "agents"),
				statuses: details.agents,
				interrupted: details.interrupted,
				error,
			}, context.toolCallId ? [context.toolCallId] : []);
		case "subagent":
		case "fork":
			if (!Array.isArray(details.agents)) {return undefined;}
			return card("delegation", state, {
				parameters: delegationParameters(context, {}),
				result: { children: delegatedChildren(context, details.agents), error },
			});
		case "interrupt":
			if (!Array.isArray(details.interrupted) && !Array.isArray(details.pending) && !Array.isArray(details.failed)) {return undefined;}
			return interruptCard(state, context, argumentNames(context, "agents"), details, error);
		case "teardown":
			if (!Array.isArray(details.affectedAgents) && !Array.isArray(details.agents)) {return undefined;}
			return card("teardown", state, {
				parameters: { agent: stringValue(context.args.agent), source: "model" },
				result: { affectedAgents: affectedAgents(context, details.affectedAgents ?? details.agents, "idle"), error },
			});
		case "resurrect":
			if (!Array.isArray(details.agents)) {return undefined;}
			return card("resurrect", state, {
				parameters: { agents: resurrectItems(context.args.agents) ?? [], source: "model" },
				result: { affectedAgents: affectedAgents(context, details.agents, "running"), error },
			});
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

function card(kind: string, state: CardState, data: Json): Candidate {
	return { kind, state, data: { operation: kind, ...data } };
}

function failure(result: Json, state: CardState, context: Context): string | undefined {
	return stringValue(result.error) ?? (state === "error" ? context.failure : undefined);
}

type AwaitInput = Readonly<{ agents: string[] | undefined; statuses: unknown; interrupted: unknown; error: string | undefined }>;

function awaitCard(state: CardState, context: Context, input: AwaitInput, invocations: readonly string[]): Candidate {
	const statuses = Array.isArray(input.statuses) ? input.statuses.flatMap((status) => agentStatus(context.owner, status) ?? []) : [];
	const repaired = repairAwait({ statuses, interrupted: input.interrupted === true ? true : undefined, error: input.error }, context.facts, invocations);
	return card("await", state, {
		parameters: { agents: input.agents },
		result: { statuses: repaired.statuses, interrupted: repaired.interrupted, error: repaired.error },
	});
}

type AwaitStatus = Readonly<{ path: AgentPath; state: string; output?: string; error?: string; sessionId?: string }>;
type AwaitResult = Readonly<{ statuses: readonly AwaitStatus[]; interrupted?: boolean; error?: string }>;

function agentStatus(owner: AgentPath, value: unknown): AwaitStatus | undefined {
	const status = asRecord(value);
	if (!status) {return undefined;}
	const path = resolvePath(owner, status.path ?? status.id);
	const state = stringValue(status.state) ?? stringValue(status.status);
	if (!path || path.length === 0 || state === undefined || !OUTCOMES.has(state)) {return undefined;}
	return { path, state, output: stringValue(status.output), error: stringValue(status.error), sessionId: stringValue(status.sessionId) };
}

/**
 * Restores await statuses that earlier versions recorded only as semantic
 * facts: children that settled during the wait, and the interruption of a
 * wait that a message released.
 */
function repairAwait(result: AwaitResult, facts: readonly Json[], invocations: readonly string[]): AwaitResult {
	const known = new Set(result.statuses.map((status) => pathKey(status.path)));
	const ownFacts = facts.filter((fact) => invocations.includes(stringValue(asRecord(fact.data)?.invocationId) ?? ""));
	for (const fact of ownFacts) {
		const data = asRecord(fact.data) ?? {};
		if ((fact.kind === "await_interrupted" || fact.kind === "await_released") && Array.isArray(data.statuses) && Array.isArray(data.requested)) {
			for (const path of data.requested) {
				if (isPath(path)) {known.add(pathKey(path));}
			}
		}
	}
	let interrupted = result.interrupted;
	let error = result.error;
	for (const fact of ownFacts) {
		const data = asRecord(fact.data) ?? {};
		if (fact.kind === "await_interrupted") {interrupted ??= true;}
		if (fact.kind === "await_released" && data.reason === "message") {
			interrupted ??= true;
			error ??= AWAIT_MESSAGE_ERROR;
		}
	}
	const restored: AwaitStatus[] = [];
	for (const fact of facts) {
		const data = asRecord(fact.data);
		if (fact.kind !== "child_settled" || !data || !Array.isArray(data.statuses)) {continue;}
		for (const value of data.statuses) {
			const status = asRecord(value);
			if (!status || !isPath(status.path) || status.path.length === 0) {continue;}
			const state = stringValue(status.state);
			const key = pathKey(status.path);
			if (state === undefined || !SETTLED.has(state) || known.has(key)) {continue;}
			known.add(key);
			restored.push({ path: [...status.path], state, output: stringValue(status.output), error: stringValue(status.error), sessionId: stringValue(status.sessionId) });
		}
	}
	return { statuses: [...result.statuses, ...restored], interrupted, error };
}

function interruptCard(state: CardState, context: Context, agents: string[] | undefined, result: Json, error: string | undefined): Candidate {
	const targets = (value: unknown) => (Array.isArray(value) ? value.flatMap((entry) => interruptTarget(context.owner, entry) ?? []) : []);
	return card("interrupt", state, {
		parameters: { agents },
		result: { interrupted: targets(result.interrupted), pending: targets(result.pending), failed: targets(result.failed), error },
	});
}

function interruptTarget(owner: AgentPath, value: unknown): Json | undefined {
	const target = asRecord(value);
	const path = resolvePath(owner, target ? target.path ?? target.id : value);
	if (!path || path.length === 0) {return undefined;}
	return { path, output: stringValue(target?.output), error: stringValue(target?.error) };
}

function delegationParameters(context: Context, parameters: Json): DelegationParameters {
	const fork = context.toolName === "fork" || (context.toolName === undefined && parameters.fork === true);
	if (fork) {
		const id = stringValue(context.args.id);
		const task = stringValue(context.args.task);
		return { agents: id !== undefined || task !== undefined ? [{ id: id ?? "", task: task ?? "" }] : delegatedAgents(parameters.agents) ?? [], fork: true };
	}
	return { agents: delegatedAgents(context.args.agents) ?? delegatedAgents(parameters.agents) ?? [], fork: false };
}

function delegatedAgents(value: unknown): Json[] | undefined {
	if (!Array.isArray(value)) {return undefined;}
	return value.flatMap((item) => {
		const agent = asRecord(item);
		if (!agent) {return [];}
		return [{
			id: stringValue(agent.id) ?? "",
			task: stringValue(agent.task) ?? "",
			persona: stringValue(agent.persona) ?? stringValue(agent.agent),
			model: stringValue(agent.model),
			cwd: stringValue(agent.cwd),
			channels: stringList(agent.channels),
		}];
	});
}

function delegatedChildren(context: Context, value: unknown): Json[] {
	if (!Array.isArray(value)) {return [];}
	const requested = delegationParameters(context, {}).agents;
	const byId = new Map(requested.flatMap((agent) => {
		const record = asRecord(agent);
		return record && typeof record.id === "string" ? [[record.id, record] as const] : [];
	}));
	return value.flatMap((entry) => {
		const child = asRecord(entry);
		const id = stringValue(child?.id);
		const path = resolvePath(context.owner, child ? child.path ?? child.id : entry);
		if (!path || path.length === 0) {return [];}
		const request = id !== undefined ? byId.get(id) : undefined;
		const status = stringValue(child?.status);
		return [{
			path,
			task: stringValue(child?.task) ?? stringValue(request?.task) ?? "",
			persona: stringValue(child?.persona) ?? stringValue(request?.persona),
			status: status !== undefined && OUTCOMES.has(status) ? status : undefined,
		}];
	});
}

function affectedAgents(context: Context, value: unknown, defaultState: string): Json[] {
	if (!Array.isArray(value)) {return [];}
	return value.flatMap((entry) => {
		const agent = asRecord(entry);
		if (!agent) {return [];}
		const path = resolvePath(context.owner, agent.path ?? agent.id);
		if (!path || path.length === 0) {return [];}
		const state = stringValue(agent.state) ?? stringValue(agent.status);
		const incarnation = stringValue(agent.incarnation);
		return [{
			path,
			sessionId: stringValue(agent.sessionId) ?? "",
			incarnation: incarnation === "unknown" ? undefined : incarnation,
			state: state !== undefined && OUTCOMES.has(state) ? state : defaultState,
			usage: usage(agent.usage),
			task: stringValue(agent.task),
			channels: stringList(agent.channels),
			model: stringValue(agent.model),
			output: stringValue(agent.output),
			error: stringValue(agent.error),
		}];
	});
}

function resurrectItems(value: unknown): Json[] | undefined {
	if (!Array.isArray(value)) {return undefined;}
	return value.flatMap((item) => {
		const agent = asRecord(item);
		if (!agent) {return [];}
		return [{
			sessionId: stringValue(agent.sessionId) ?? "",
			id: stringValue(agent.id) ?? "",
			task: stringValue(agent.task) ?? "",
			channels: stringList(agent.channels),
			model: stringValue(agent.model),
		}];
	});
}

function usage(value: unknown): Json | undefined {
	const source = asRecord(value);
	if (!source) {return undefined;}
	const breakdown = asRecord(source.costBreakdown);
	return {
		input: finite(source.input),
		output: finite(source.output),
		cacheRead: finite(source.cacheRead),
		cacheWrite: finite(source.cacheWrite),
		cost: finite(source.cost),
		costBreakdown: breakdown
			? { input: finite(breakdown.input), output: finite(breakdown.output), cacheRead: finite(breakdown.cacheRead), cacheWrite: finite(breakdown.cacheWrite) }
			: undefined,
		turns: finite(source.turns),
	};
}

/** The recipient of a response, from the `message_thread` response fact. */
function respondTarget(context: Context): AgentPath | undefined {
	for (const fact of context.facts) {
		const data = asRecord(fact.data);
		if (fact.kind === "message_thread" && data?.phase === "response" && isPath(data.to)) {return [...data.to];}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Paths and values
// ---------------------------------------------------------------------------

function factList(value: unknown): Json[] {
	return (Array.isArray(value) ? value : [value]).flatMap((fact): Json[] => { const record = asRecord(fact); return record ? [record] : []; });
}

/** Root-relative path of a legacy path value or a local agent reference. */
function resolvePath(owner: AgentPath, value: unknown): AgentPath | undefined {
	if (Array.isArray(value)) {return value.filter((part): part is string => typeof part === "string" && part.length > 0);}
	if (typeof value !== "string" || value.length === 0) {return undefined;}
	if (value === "parent") {return owner.slice(0, -1);}
	const path = value.split("/").filter(Boolean);
	return owner.length > 0 && owner.every((part, index) => part === path[index]) ? path : [...owner, ...path];
}

/** The reference the owner would pass as a tool argument to reach `path`. */
function relativeName(owner: AgentPath, path: AgentPath | undefined): string | undefined {
	if (!path) {return undefined;}
	const parent = owner.slice(0, -1);
	if (owner.length > 0 && pathKey(path) === pathKey(parent)) {return "parent";}
	for (const base of [owner, parent]) {
		if (path.length > base.length && base.every((part, index) => part === path[index])) {return path.slice(base.length).join("/");}
	}
	return path.join("/");
}

function pathNames(owner: AgentPath, value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {return undefined;}
	const names = value.flatMap((entry) => relativeName(owner, resolvePath(owner, entry)) || []);
	return names.length > 0 ? names : undefined;
}

function argumentNames(context: Context, key: string): string[] | undefined {
	const names = stringList(context.args[key]);
	return names && names.length > 0 ? names : undefined;
}

function isPath(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((part) => typeof part === "string");
}

function pathKey(path: readonly string[]): string {
	return JSON.stringify(path);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Attributes of each `<tag ...>` element in message content, in order. */
function tagAttributes(content: string, tag: string): Json[] {
	return [...content.matchAll(new RegExp(`<${tag}\\s([^>]*)>`, "g"))].map((match) =>
		Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]])));
}
