import { describe, expect, it, vi } from "vitest";
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	type AssistantMessage,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	RETRYABLE_ERROR_PREFIX,
	makeRetryable,
	mapRetryableErrors,
} from "./retryable-errors.js";

const model = { api: "openai-responses", provider: "quota-provider", id: "model" } as any;
const context = { messages: [], tools: [] } as any;

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "quota-provider",
		model: "model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		stopReason: "error",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

function errorStream(
	message: AssistantMessage,
	reason: "error" | "aborted" = "error",
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "error", reason, error: message });
	stream.end();
	return stream;
}

function doneStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end();
	return stream;
}

const always = () => true;
const never = () => false;

describe("makeRetryable", () => {
	it("prefixes with wording pi's classifier already treats as retryable", () => {
		for (const text of [
			"The encrypted content for item rs_123 could not be verified.",
			"upstream exploded",
			"ordinary failure text with no known keywords",
		]) {
			expect(isRetryableAssistantError(assistantMessage({ errorMessage: makeRetryable(text) })))
				.toBe(true);
		}
	});

	it("is idempotent", () => {
		const once = makeRetryable("boom");
		expect(makeRetryable(once)).toBe(once);
	});
});

describe("mapRetryableErrors", () => {
	it("rewrites a terminal error the impl classifies as transient", async () => {
		const message = assistantMessage({ errorMessage: "rotation glitch" });
		const wrapped = mapRetryableErrors(() => errorStream(message), always);

		const final = await wrapped(model, context).result();
		expect(final.errorMessage).toBe(`${RETRYABLE_ERROR_PREFIX}rotation glitch`);
		expect(isRetryableAssistantError(final)).toBe(true);
	});

	it("passes the raw message to the predicate and leaves non-matching errors alone", async () => {
		const seen: string[] = [];
		const message = assistantMessage({ errorMessage: "hard failure" });
		const wrapped = mapRetryableErrors(
			() => errorStream(message),
			(m) => (seen.push(m), false),
		);

		const final = await wrapped(model, context).result();
		expect(seen).toEqual(["hard failure"]);
		expect(final.errorMessage).toBe("hard failure");
		expect(isRetryableAssistantError(final)).toBe(false);
	});

	it("never touches aborted results", async () => {
		const message = assistantMessage({ errorMessage: "Request was aborted", stopReason: "aborted" });
		const wrapped = mapRetryableErrors(() => errorStream(message, "aborted"), always);

		const final = await wrapped(model, context).result();
		expect(final.errorMessage).toBe("Request was aborted");
	});

	it("passes successful streams through unchanged", async () => {
		const message = assistantMessage({ stopReason: "stop", errorMessage: undefined });
		const wrapped = mapRetryableErrors(() => doneStream(message), always);

		const final = await wrapped(model, context).result();
		expect(final.stopReason).toBe("stop");
		expect(final.errorMessage).toBeUndefined();
	});

	it("rewrites once when the stream is both iterated and resolved", async () => {
		const message = assistantMessage({ errorMessage: "rotation glitch" });
		const wrapped = mapRetryableErrors(() => errorStream(message), always);
		const out = wrapped(model, context);

		for await (const _event of out) { /* consume */ }
		const final = await out.result();
		expect(final.errorMessage).toBe(`${RETRYABLE_ERROR_PREFIX}rotation glitch`);
	});

	it("rewrites streams that complete via end(result) without a terminal event", async () => {
		const message = assistantMessage({ errorMessage: "rotation glitch" });
		const source = createAssistantMessageEventStream();
		source.end(message);
		const wrapped = mapRetryableErrors(() => source, always);

		const final = await wrapped(model, context).result();
		expect(final.errorMessage).toBe(`${RETRYABLE_ERROR_PREFIX}rotation glitch`);
	});

	it("treats a throwing predicate as non-retryable and keeps the stream intact", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const message = assistantMessage({ errorMessage: "rotation glitch" });
		const wrapped = mapRetryableErrors(() => errorStream(message), () => {
			throw new Error("predicate boom");
		});

		const final = await wrapped(model, context).result();
		expect(final.errorMessage).toBe("rotation glitch");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("warns when non-retryable wording still wins after the rewrite", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const message = assistantMessage({ errorMessage: "billing window exhausted" });
		const wrapped = mapRetryableErrors(() => errorStream(message), always);

		const final = await wrapped(model, context).result();
		expect(final.errorMessage).toBe(`${RETRYABLE_ERROR_PREFIX}billing window exhausted`);
		// pi's non-retryable patterns are checked first and win — documented trap.
		expect(isRetryableAssistantError(final)).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("rewrite ineffective"));
		warn.mockRestore();
	});
});
