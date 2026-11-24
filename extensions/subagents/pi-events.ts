/**
 * Typed envelopes for the pi extension events this package observes.
 *
 * The SDK declares most events it emits. Gaps stay here: `entry_appended`
 * reaches handlers but is absent from the public union, and several fields are
 * typed `any` or undeclared. Handlers narrow those fields through the views
 * below instead of trusting the payload.
 */
import type {
	AgentEndEvent,
	AgentStartEvent,
	AgentSettledEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { asRecord, numberField, stringField } from "./narrow.js";

/** A session entry the runtime appends, emitted outside the SDK union. */
export type EntryAppendedEvent = {
	type: "entry_appended";
	entry: {
		id?: unknown;
		message?: unknown;
		customType?: unknown;
		details?: unknown;
		data?: unknown;
	};
};

/** Every event a handler in this package can observe. */
export type ObservedPiEvent = ExtensionEvent | EntryAppendedEvent;

/** Registered event names and the payload each handler receives. */
export type PiEventMap = {
	agent_end: AgentEndEvent;
	agent_start: AgentStartEvent;
	agent_settled: AgentSettledEvent;
	before_agent_start: BeforeAgentStartEvent;
	entry_appended: EntryAppendedEvent;
	message_end: MessageEndEvent;
	message_update: MessageUpdateEvent;
	session_info_changed: SessionInfoChangedEvent;
	session_shutdown: SessionShutdownEvent;
	session_start: SessionStartEvent;
	tool_call: ToolCallEvent;
	tool_execution_end: ToolExecutionEndEvent;
	tool_execution_start: ToolExecutionStartEvent;
	tool_result: ToolResultEvent;
};

/** Names of the events this package registers. */
export type PiEventName = keyof PiEventMap;

/** The value one event handler returns. */
export type PiEventResult<K extends PiEventName> = K extends "tool_call"
	? ToolCallEventResult | undefined
	: K extends "tool_result"
		? { details: unknown } | undefined
		: void;

/** A handler per registered event, each typed by that event's payload. */
export type PiEventHandlers = {
	[K in PiEventName]: (event: PiEventMap[K]) => PiEventResult<K> | Promise<PiEventResult<K>>;
};

/**
 * Register a handler for an event pi emits outside its typed overloads.
 *
 * The runtime accepts the name; the SDK overload list does not declare it.
 */
export function onUnlistedEvent(
	api: ExtensionAPI,
	eventName: "entry_appended",
	handler: (event: EntryAppendedEvent, ctx: ExtensionContext) => unknown,
): void {
	const registrar: { on(name: string, callback: typeof handler): void } = api as unknown as {
		on(name: string, callback: typeof handler): void;
	};
	registrar.on(eventName, handler);
}

/** A tool result read through its declared and undeclared fields. */
export type ToolResultView = {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content?: unknown;
	input?: unknown;
	details?: unknown;
	structuredContent?: unknown;
	usage?: unknown;
	result?: unknown;
};

/** Read a tool result, including the `result` field pi leaves undeclared. */
export function toolResultView(event: ToolResultEvent): ToolResultView {
	const raw = asRecord(event) ?? {};
	return {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		isError: event.isError,
		content: event.content,
		input: event.input,
		details: raw.details,
		structuredContent: event.structuredContent,
		usage: event.usage,
		result: raw.result,
	};
}

/** A tool-execution start read through declared and observed fields. */
export type ToolExecutionStartView = {
	toolCallId: string;
	toolName: string | undefined;
	args: unknown;
};

/** Read a tool-execution start; the runtime also reports the tool under `tool`. */
export function toolExecutionStartView(event: ToolExecutionStartEvent): ToolExecutionStartView {
	const raw = asRecord(event);
	return {
		toolCallId: event.toolCallId,
		toolName: event.toolName ?? stringField(raw?.tool, "name"),
		args: event.args ?? raw?.input,
	};
}

/** A tool-execution end read through declared and observed fields. */
export type ToolExecutionEndView = {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	contentIndex: number | undefined;
	result: unknown;
};

/** Read a tool-execution end; the runtime also reports `contentIndex`. */
export function toolExecutionEndView(event: ToolExecutionEndEvent): ToolExecutionEndView {
	const raw = asRecord(event);
	return {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		isError: event.isError,
		contentIndex: numberField(raw, "contentIndex"),
		result: raw?.result,
	};
}

/** A tool-call part seen during message streaming. */
export type ToolCallUpdateView = {
	contentIndex: number;
	toolCallId: string | undefined;
	toolName: string | undefined;
	args: unknown;
};

/** Read one element of an unknown array value. */
function pickIndex(value: unknown, index: number): unknown {
	return Array.isArray(value) ? value[index] : undefined;
}

/** Read a streamed tool-call part, or undefined for any other update. */
export function toolCallUpdateView(event: MessageUpdateEvent): ToolCallUpdateView | undefined {
	const update = asRecord(event.assistantMessageEvent);
	if (!update) {return undefined;}
	const updateType = stringField(update, "type");
	if (updateType !== "toolcall_start" && updateType !== "toolcall_delta" && updateType !== "toolcall_end") {return undefined;}
	const contentIndex = numberField(update, "contentIndex");
	if (contentIndex === undefined) {return undefined;}
	const fromPartial = pickIndex(asRecord(update.partial)?.["content"], contentIndex);
	const fromMessage = pickIndex(asRecord(event.message)?.["content"], contentIndex);
	const toolCall = asRecord(update.toolCall) ?? asRecord(fromPartial ?? fromMessage);
	return {
		contentIndex,
		toolCallId: stringField(toolCall, "id"),
		toolName: stringField(toolCall, "name"),
		args: asRecord(toolCall)?.["arguments"],
	};
}
