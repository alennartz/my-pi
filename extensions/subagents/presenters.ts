/**
 * Pure presenters for subagent tool calls and `subagents` custom messages.
 *
 * Every card derives from native pi data: tool arguments, `onUpdate`
 * progress, tool result details, and custom message details. Pimote calls the
 * same functions for live events and for saved entries, so a live card and a
 * reloaded card cannot differ.
 */
import type {
	AgentPath,
	SubagentAffectedAgent,
	SubagentAgentOutcome,
	SubagentAgentStatus,
	SubagentCostBreakdown,
	SubagentDelegatedAgent,
	SubagentDelegatedChild,
	SubagentInterruptTarget,
	SubagentJsonValue,
	SubagentMessageInput,
	SubagentOperationKind,
	SubagentOperationSource,
	SubagentPresentation,
	SubagentPresentationData,
	SubagentPresentationState,
	SubagentPresenters,
	SubagentResurrectItem,
	SubagentToolCallInput,
	SubagentUsage,
} from "@pimote/sdk/subagents";
import { asRecord } from "./narrow.js";
import { legacyMessageCards, legacyToolCard } from "./presenters-legacy.js";

/** One card without its path. Pimote supplies the path as ownerPath. */
export type SubagentCard = Omit<SubagentPresentation, "path">;

export const SUBAGENT_CUSTOM_TYPE = "subagents";

export const SUBAGENT_TOOL_NAMES = Object.freeze(["send", "respond", "await_agents", "subagent", "fork", "interrupt", "teardown", "resurrect"] as const);

export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

/** Tool result and `onUpdate` details: one card. */
export type SubagentToolCardDetails = { subagent: SubagentCard };

/** `subagents` custom message details: ordered cards. */
export type SubagentMessageCardDetails = { subagent: SubagentCard[] };

export function toolCardDetails(card: SubagentCard): SubagentToolCardDetails {
	return { subagent: card };
}

export function messageCardDetails(cards: readonly SubagentCard[]): SubagentMessageCardDetails {
	return { subagent: [...cards] };
}

export type SubagentPresentersOptions = Readonly<{
	runningToolProgress(input: Readonly<{ sessionId: string; toolCallId: string }>): SubagentJsonValue | undefined;
}>;

export function createSubagentPresenters(options: SubagentPresentersOptions): SubagentPresenters {
	return Object.freeze({
		toolNames: SUBAGENT_TOOL_NAMES,
		customTypes: Object.freeze([SUBAGENT_CUSTOM_TYPE]),
		presentToolCall,
		presentMessage,
		runningToolProgress(input: Readonly<{ sessionId: string; toolCallId: string }>): SubagentJsonValue | undefined {
			try {
				return options.runningToolProgress(input);
			} catch (error) {
				console.error("[subagents] Running tool progress failed:", error);
				return undefined;
			}
		},
	});
}

const TOOL_KINDS: Readonly<Record<SubagentToolName, SubagentOperationKind>> = Object.freeze({
	send: "send",
	respond: "respond",
	await_agents: "await",
	subagent: "delegation",
	fork: "delegation",
	interrupt: "interrupt",
	teardown: "teardown",
	resurrect: "resurrect",
});

function isToolName(value: unknown): value is SubagentToolName {
	return typeof value === "string" && (SUBAGENT_TOOL_NAMES as readonly string[]).includes(value);
}

function presentToolCall(input: SubagentToolCallInput): SubagentPresentation | undefined {
	try {
		const call = asRecord(input);
		if (!call || !isToolName(call.toolName)) {return undefined;}
		const owner = ownerPath(call.ownerPath);
		const execution = asRecord(call.execution);
		if (!owner || !execution) {return undefined;}
		const card = toolCard(input, TOOL_KINDS[call.toolName]);
		return card ? present(card, owner, correlationIds(input)) : undefined;
	} catch (error) {
		console.error("[subagents] Presenting a tool call failed:", error);
		return undefined;
	}
}

function presentMessage(input: SubagentMessageInput): readonly SubagentPresentation[] | undefined {
	try {
		const message = asRecord(input);
		if (!message || message.customType !== SUBAGENT_CUSTOM_TYPE) {return undefined;}
		const owner = ownerPath(message.ownerPath);
		if (!owner) {return undefined;}
		const ids = correlationIds(input);
		const stored = asRecord(message.details)?.subagent;
		const candidates: readonly unknown[] = Array.isArray(stored) ? stored : legacyMessageCards(input);
		const cards = candidates.flatMap((candidate) => {
			const card = decodeCard(candidate);
			return card ? [present(card, owner, ids)] : [];
		});
		return cards.length > 0 ? cards : undefined;
	} catch (error) {
		console.error("[subagents] Presenting a message failed:", error);
		return undefined;
	}
}

function toolCard(input: SubagentToolCallInput, kind: SubagentOperationKind): SubagentCard | undefined {
	const execution = input.execution;
	if (execution.state === "complete" || execution.state === "error") {
		const stored = storedCard(asRecord(execution.details)?.subagent, kind);
		if (stored) {return stored.state === "active" ? { ...stored, state: execution.state } : stored;}
		const legacy = storedCard(legacyToolCard(input), kind);
		if (legacy) {return legacy;}
	}
	if (execution.state === "running") {
		const progress = storedCard(asRecord(execution.progress)?.subagent, kind);
		if (progress) {return { ...progress, state: "active" };}
	}
	return deriveCard(input, kind);
}

function storedCard(value: unknown, kind: SubagentOperationKind): SubagentCard | undefined {
	const card = decodeCard(value);
	return card?.kind === kind ? card : undefined;
}

function present(card: SubagentCard, owner: AgentPath, ids: readonly string[]): SubagentPresentation {
	const redacted = redact(card, ids);
	return { kind: redacted.kind, state: redacted.state, path: owner, data: redacted.data };
}

function ownerPath(value: unknown): AgentPath | undefined {
	return Array.isArray(value) && value.every((segment) => typeof segment === "string" && segment.length > 0) ? [...value] : undefined;
}

// ---------------------------------------------------------------------------
// Correlation identifiers
// ---------------------------------------------------------------------------

const CORRELATION_KEYS: ReadonlySet<string> = new Set(["correlationId", "correlation_id", "pendingCorrelations", "pending_correlations"]);
const CORRELATION_PATTERN = /corr-[0-9a-f]+-\d+/g;
const REDACTED = "[redacted]";

/** Every correlation identifier stored under a correlation key anywhere in the input. */
function correlationIds(input: unknown): readonly string[] {
	const ids = new Set<string>();
	const visit = (value: unknown, underKey: boolean): void => {
		if (typeof value === "string") {
			if (underKey && value.length > 0) {ids.add(value);}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {visit(item, underKey);}
			return;
		}
		const record = asRecord(value);
		if (!record) {return;}
		for (const [key, child] of Object.entries(record)) {visit(child, CORRELATION_KEYS.has(key));}
	};
	visit(input, false);
	return [...ids].toSorted((left, right) => right.length - left.length);
}

function redactText(text: string, ids: readonly string[]): string {
	const known = ids.reduce((current, id) => current.replaceAll(id, REDACTED), text);
	return known.replaceAll(CORRELATION_PATTERN, REDACTED);
}

/** A copy of the card without correlation members and with every correlation identifier redacted. */
function redact(card: SubagentCard, ids: readonly string[]): SubagentCard {
	return JSON.parse(JSON.stringify(card), (key: string, member: SubagentJsonValue) => {
		if (CORRELATION_KEYS.has(key)) {return undefined;}
		return typeof member === "string" ? redactText(member, ids) : member;
	}) as SubagentCard;
}

// ---------------------------------------------------------------------------
// Card derivation from arguments and result text
// ---------------------------------------------------------------------------

function executionState(input: SubagentToolCallInput): SubagentPresentationState {
	switch (input.execution.state) {
		case "complete": return "complete";
		case "error": return "error";
		case "aborted": return "aborted";
		default: return "active";
	}
}

function deriveCard(input: SubagentToolCallInput, kind: SubagentOperationKind): SubagentCard | undefined {
	const args = asRecord(input.args) ?? {};
	const state = executionState(input);
	const text = input.execution.state === "complete" || input.execution.state === "error" ? stringOr(input.execution.text, "") : "";
	const error = state === "error" ? text : undefined;
	const data = deriveData(input.toolName, kind, args, state, text, error);
	return data ? { kind, state, data } : undefined;
}

function deriveData(
	toolName: string,
	kind: SubagentOperationKind,
	args: Readonly<Record<string, unknown>>,
	state: SubagentPresentationState,
	text: string,
	error: string | undefined,
): SubagentPresentationData | undefined {
	switch (kind) {
		case "send": {
			const expectResponse = args.expectResponse === true;
			const response = state === "complete" && expectResponse ? text : undefined;
			return {
				operation: "send",
				parameters: { to: stringOr(args.to, ""), message: stringOr(args.message, ""), expectResponse },
				result: compact({ phase: state === "active" ? "sending" : "complete", response, error }),
			};
		}
		case "respond":
			return { operation: "respond", parameters: { message: stringOr(args.message, "") }, result: compact({ error }) };
		case "await":
			return { operation: "await", parameters: compact({ agents: agentNames(args.agents) }), result: compact({ statuses: [], error }) };
		case "delegation":
			return {
				operation: "delegation",
				parameters: { agents: toolName === "fork" ? forkAgents(args) : delegatedAgents(args.agents), fork: toolName === "fork" },
				result: compact({ children: [], error }),
			};
		case "interrupt":
			return { operation: "interrupt", parameters: compact({ agents: agentNames(args.agents) }), result: compact({ interrupted: [], pending: [], failed: [], error }) };
		case "teardown":
			return {
				operation: "teardown",
				parameters: compact({ agent: optionalString(args.agent), source: "model" as const }),
				result: compact({ affectedAgents: [], error }),
			};
		case "resurrect":
			return { operation: "resurrect", parameters: { agents: resurrectItems(args.agents), source: "model" }, result: compact({ affectedAgents: [], error }) };
		default:
			return undefined;
	}
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function agentNames(value: unknown): string[] | undefined {
	const names = strings(value);
	return names && names.length > 0 ? names : undefined;
}

function delegatedAgents(value: unknown): SubagentDelegatedAgent[] {
	if (!Array.isArray(value)) {return [];}
	return value.flatMap((item) => {
		const agent = asRecord(item);
		if (!agent) {return [];}
		return [compact({
			id: stringOr(agent.id, ""),
			task: stringOr(agent.task, ""),
			persona: optionalString(agent.persona) ?? optionalString(agent.agent),
			model: optionalString(agent.model),
			cwd: optionalString(agent.cwd),
			channels: strings(agent.channels),
		})];
	});
}

function forkAgents(args: Readonly<Record<string, unknown>>): SubagentDelegatedAgent[] {
	if (typeof args.id !== "string" && typeof args.task !== "string") {return [];}
	return [{ id: stringOr(args.id, ""), task: stringOr(args.task, "") }];
}

function resurrectItems(value: unknown): SubagentResurrectItem[] {
	if (!Array.isArray(value)) {return [];}
	return value.flatMap((item) => {
		const agent = asRecord(item);
		if (!agent) {return [];}
		return [compact({
			sessionId: stringOr(agent.sessionId, ""),
			id: stringOr(agent.id, ""),
			task: stringOr(agent.task, ""),
			channels: strings(agent.channels),
			model: optionalString(agent.model),
		})];
	});
}

/** The object without its undefined members. */
function compact<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Stored card validation
//
// Details are untrusted JSON. A decoder reads only declared members, so a
// stored card never carries private fields into the output. Any structural
// mismatch rejects the whole card.
// ---------------------------------------------------------------------------

function invalid(): never {
	throw new Error("invalid subagent card");
}

type Decoder<T> = (value: unknown) => T;

const KINDS: readonly SubagentOperationKind[] = ["send", "message_received", "respond", "await", "delegation", "completion", "interrupt", "teardown", "resurrect"];
const STATES: readonly SubagentPresentationState[] = ["active", "complete", "error", "aborted"];
const OUTCOMES: readonly SubagentAgentOutcome[] = ["running", "waiting", "idle", "errored", "dead", "stopped", "held", "removed"];
const SEND_PHASES = ["sending", "waiting", "responding", "complete"] as const;
const SOURCES: readonly SubagentOperationSource[] = ["model", "user"];

/** A stored card, or undefined when it fails validation. */
function decodeCard(value: unknown): SubagentCard | undefined {
	try {
		const card = record(value);
		const kind = oneOf(KINDS)(card.kind);
		const state = oneOf(STATES)(card.state);
		const data = record(card.data);
		if (data.operation !== kind) {invalid();}
		return { kind, state, data: cardData(kind, data) };
	} catch {
		return undefined;
	}
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	return asRecord(value) ?? invalid();
}

function text(value: unknown): string {
	return typeof value === "string" ? value : invalid();
}

function flag(value: unknown): boolean {
	return typeof value === "boolean" ? value : invalid();
}

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : invalid();
}

function list<T>(decode: Decoder<T>): Decoder<T[]> {
	return (value) => (Array.isArray(value) ? value.map((item) => decode(item)) : invalid());
}

function oneOf<T extends string>(values: readonly T[]): Decoder<T> {
	return (value) => (typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : invalid());
}

function optional<T>(value: unknown, decode: Decoder<T>): T | undefined {
	return value === undefined || value === null ? undefined : decode(value);
}

function segment(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : invalid();
}

const agentPath: Decoder<AgentPath> = list(segment);
const texts: Decoder<string[]> = list(text);

function costBreakdown(value: unknown): SubagentCostBreakdown {
	const source = record(value);
	return { input: amount(source.input), output: amount(source.output), cacheRead: amount(source.cacheRead), cacheWrite: amount(source.cacheWrite) };
}

function usage(value: unknown): SubagentUsage {
	const source = record(value);
	return compact({
		input: amount(source.input),
		output: amount(source.output),
		cacheRead: amount(source.cacheRead),
		cacheWrite: amount(source.cacheWrite),
		cost: amount(source.cost),
		costBreakdown: optional(source.costBreakdown, costBreakdown),
		turns: amount(source.turns),
	});
}

function agentStatus(value: unknown): SubagentAgentStatus {
	const source = record(value);
	return compact({
		path: agentPath(source.path),
		state: oneOf(OUTCOMES)(source.state),
		output: optional(source.output, text),
		error: optional(source.error, text),
		sessionId: optional(source.sessionId, text),
		usage: optional(source.usage, usage),
		replacedHeldResult: optional(source.replacedHeldResult, flag),
	});
}

function delegatedAgent(value: unknown): SubagentDelegatedAgent {
	const source = record(value);
	return compact({
		id: text(source.id),
		task: text(source.task),
		persona: optional(source.persona, text),
		model: optional(source.model, text),
		cwd: optional(source.cwd, text),
		channels: optional(source.channels, texts),
	});
}

function delegatedChild(value: unknown): SubagentDelegatedChild {
	const source = record(value);
	return compact({
		path: agentPath(source.path),
		task: text(source.task),
		persona: optional(source.persona, text),
		status: optional(source.status, oneOf(OUTCOMES)),
	});
}

function affectedAgent(value: unknown): SubagentAffectedAgent {
	const source = record(value);
	return compact({
		path: agentPath(source.path),
		sessionId: text(source.sessionId),
		incarnation: optional(source.incarnation, text),
		state: oneOf(OUTCOMES)(source.state),
		usage: optional(source.usage, usage),
		task: optional(source.task, text),
		channels: optional(source.channels, texts),
		model: optional(source.model, text),
		output: optional(source.output, text),
		error: optional(source.error, text),
	});
}

function interruptTarget(value: unknown): SubagentInterruptTarget {
	const source = record(value);
	return compact({ path: agentPath(source.path), output: optional(source.output, text), error: optional(source.error, text) });
}

function resurrectItem(value: unknown): SubagentResurrectItem {
	const source = record(value);
	return compact({
		sessionId: text(source.sessionId),
		id: text(source.id),
		task: text(source.task),
		channels: optional(source.channels, texts),
		model: optional(source.model, text),
	});
}

function cardData(kind: SubagentOperationKind, data: Readonly<Record<string, unknown>>): SubagentPresentationData {
	const parameters = record(data.parameters);
	const result = record(data.result);
	const error = optional(result.error, text);
	switch (kind) {
		case "delegation":
			return {
				operation: "delegation",
				parameters: { agents: list(delegatedAgent)(parameters.agents), fork: flag(parameters.fork) },
				result: compact({ children: list(delegatedChild)(result.children), error }),
			};
		case "send":
			return {
				operation: "send",
				parameters: { to: text(parameters.to), message: text(parameters.message), expectResponse: flag(parameters.expectResponse) },
				result: compact({ phase: oneOf(SEND_PHASES)(result.phase), response: optional(result.response, text), error }),
			};
		case "message_received":
			return {
				operation: "message_received",
				parameters: { from: agentPath(parameters.from), message: text(parameters.message), expectResponse: flag(parameters.expectResponse) },
				result: compact({ error }),
			};
		case "respond":
			return {
				operation: "respond",
				parameters: compact({ to: optional(parameters.to, agentPath), message: text(parameters.message) }),
				result: compact({ error }),
			};
		case "await":
			return {
				operation: "await",
				parameters: compact({ agents: optional(parameters.agents, texts) }),
				result: compact({ statuses: list(agentStatus)(result.statuses), interrupted: optional(result.interrupted, flag), error }),
			};
		case "completion":
			return { operation: "completion", parameters: {}, result: agentStatus(result) };
		case "interrupt":
			return {
				operation: "interrupt",
				parameters: compact({ agents: optional(parameters.agents, texts) }),
				result: compact({
					interrupted: list(interruptTarget)(result.interrupted),
					pending: list(interruptTarget)(result.pending),
					failed: list(interruptTarget)(result.failed),
					error,
				}),
			};
		case "teardown":
			return {
				operation: "teardown",
				parameters: compact({ agent: optional(parameters.agent, text), source: oneOf(SOURCES)(parameters.source) }),
				result: compact({ affectedAgents: list(affectedAgent)(result.affectedAgents), error }),
			};
		case "resurrect":
			return {
				operation: "resurrect",
				parameters: { agents: list(resurrectItem)(parameters.agents), source: oneOf(SOURCES)(parameters.source) },
				result: compact({ affectedAgents: list(affectedAgent)(result.affectedAgents), error }),
			};
		default:
			return invalid();
	}
}
