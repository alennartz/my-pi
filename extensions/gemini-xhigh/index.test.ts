import { describe, expect, it } from "vitest";

import { applyXhighThinkingLevel } from "./index.ts";

/** The SDK-shaped Google request: config lives under `config`. */
function sdkPayload(level: string) {
	return { model: "gemini-4-hydrogen", contents: [], config: { thinkingConfig: { includeThoughts: true, thinkingLevel: level } } };
}

/** The REST-shaped Google request: config lives under `generationConfig`. */
function restPayload(level: string) {
	return { model: "gemini-4-hydrogen", contents: [], generationConfig: { thinkingConfig: { thinkingLevel: level } } };
}

describe("applyXhighThinkingLevel", () => {
	it("sends XHIGH for an xhigh session on a Google API", () => {
		const result = applyXhighThinkingLevel(sdkPayload("HIGH"), "google-generative-ai", "xhigh") as any;
		expect(result.config.thinkingConfig.thinkingLevel).toBe("XHIGH");
	});

	it("sends XHIGH on a REST-shaped Google payload", () => {
		const result = applyXhighThinkingLevel(restPayload("HIGH"), "google-vertex", "xhigh") as any;
		expect(result.generationConfig.thinkingConfig.thinkingLevel).toBe("XHIGH");
	});

	it("leaves a high session at HIGH", () => {
		const result = applyXhighThinkingLevel(sdkPayload("HIGH"), "google-generative-ai", "high") as any;
		expect(result.config.thinkingConfig.thinkingLevel).toBe("HIGH");
	});

	it("leaves non-Google APIs untouched", () => {
		const payload = sdkPayload("HIGH");
		const result = applyXhighThinkingLevel(payload, "openai-completions", "xhigh");
		expect(result).toBe(payload);
	});

	it("leaves a Google request without a thinking config untouched", () => {
		const payload = { model: "gemini-4-hydrogen", contents: [], config: {} };
		expect(applyXhighThinkingLevel(payload, "google-generative-ai", "xhigh")).toBe(payload);
	});

	it("leaves a payload that already reads XHIGH alone", () => {
		const result = applyXhighThinkingLevel(sdkPayload("XHIGH"), "google-generative-ai", "xhigh") as any;
		expect(result.config.thinkingConfig.thinkingLevel).toBe("XHIGH");
	});
});
