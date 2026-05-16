import { describe, expect, it } from "vitest";
import { applyStopSequences } from "./stop-sequences.js";

describe("applyStopSequences", () => {
	it("uses stop_sequences for anthropic", () => {
		const payload: any = {};
		applyStopSequences(payload, "anthropic-messages", ["<agent_idle"]);
		expect(payload.stop_sequences).toEqual(["<agent_idle"]);
	});

	it("uses top-level stop for chat-completions style APIs", () => {
		const payload: any = {};
		applyStopSequences(payload, "openai-completions", ["<agent_idle"]);
		expect(payload.stop).toEqual(["<agent_idle"]);
	});

	it("uses instructions fallback for responses APIs", () => {
		const payload: any = {};
		applyStopSequences(payload, "openai-responses", ["<agent_idle"]);
		expect(payload.stop).toBeUndefined();
		expect(payload.instructions).toContain("System-delivered notification markers");
		expect(payload.instructions).toContain("<agent_idle");
	});

	it("appends fallback instructions to existing responses instructions", () => {
		const payload: any = { instructions: "Existing instruction." };
		applyStopSequences(payload, "azure-openai-responses", ["<agent_idle"]);
		expect(payload.instructions).toContain("Existing instruction.");
		expect(payload.instructions).toContain("<agent_idle");
	});
});
