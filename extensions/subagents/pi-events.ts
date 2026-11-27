/**
 * Views over pi event fields that the SDK types as `any` or leaves
 * undeclared. Handlers narrow those fields here instead of trusting them.
 */
import type { MessageUpdateEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { asRecord, numberField, stringField } from "./narrow.js";
import type { JsonValue } from "@earendil-works/pi-ai";

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

/** A tool-call part seen during message streaming. */
export type ToolCallUpdateView = {
	contentIndex: number;
	toolCallId: string | undefined;
	toolName: string | undefined;
	args: unknown;
};

/** Read one element of an unknown array value. */
function pickIndex(value: unknown, index: number): JsonValue | undefined {
	const element: JsonValue | undefined = Array.isArray(value) ? value[index] : undefined;
	return element;
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
