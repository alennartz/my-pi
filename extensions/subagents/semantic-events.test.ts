import { describe, expect, it } from "vitest";
import { createSemanticEvent } from "./semantic-events.js";
import type { PiEventRef } from "./provider.js";

const cursor = { epoch: "epoch-a", sequence: 7 } as const;

function piRef(overrides: Partial<PiEventRef> = {}): PiEventRef {
	return {
		sessionId: "child-session",
		kind: "message",
		...overrides,
	};
}

describe("semantic event provenance", () => {
	it("retains every native Pi reference for one communication event", () => {
		const refs: readonly PiEventRef[] = [
			piRef({ entryId: "request-entry" }),
			piRef({ entryId: "tool-entry", toolCallId: "call-1", kind: "tool_call" }),
			piRef({ entryId: "reply-entry", kind: "custom_message" }),
		];

		const semantic = createSemanticEvent({
			eventId: "semantic-1",
			cursor,
			path: ["worker", "scout"],
			kind: "message_thread",
			relatedPiEvents: refs,
			data: {
				phase: "response",
				from: ["worker", "scout"],
				to: ["worker"],
				text: "The session store owns the mutation.",
				correlationId: "corr-1",
				responseExpected: false,
			},
		});

		expect(semantic.relatedPiEvents).toEqual(refs);
		expect(semantic.relatedPiEvents).toHaveLength(3);
		expect(semantic.path).toEqual(["worker", "scout"]);
		expect(semantic.kind).toBe("message_thread");
	});

	it("allows a topology fact to have no native transcript reference", () => {
		const semantic = createSemanticEvent({
			eventId: "semantic-2",
			cursor,
			path: ["worker"],
			kind: "node_added",
			relatedPiEvents: [],
			data: { sessionId: "child-session" },
		});

		expect(semantic.relatedPiEvents).toEqual([]);
		expect(semantic.data).toEqual({ sessionId: "child-session" });
	});

	it("keeps lifecycle references distinct from the semantic overlay kind", () => {
		const semantic = createSemanticEvent({
			eventId: "semantic-3",
			cursor,
			path: ["worker"],
			kind: "teardown",
			relatedPiEvents: [piRef({ kind: "lifecycle", entryId: "teardown-entry" })],
			data: { status: "removed" },
		});

		expect(semantic.kind).toBe("teardown");
		expect(semantic.relatedPiEvents[0]).toMatchObject({
			kind: "lifecycle",
			entryId: "teardown-entry",
		});
	});
});
