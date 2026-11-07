import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelRef, parseDetail } from "./run.mjs";

test("normalizes the status display's valid thinking suffix", () => {
	assert.deepEqual(normalizeModelRef("gpt-4o-mini:off"), {
		model: "gpt-4o-mini",
		thinkingLevel: "off",
	});
	assert.deepEqual(normalizeModelRef("provider/model:high"), {
		model: "provider/model",
		thinkingLevel: "high",
	});
});

test("does not strip a non-thinking model suffix", () => {
	assert.deepEqual(normalizeModelRef("openai/gpt-5:exacto"), {
		model: "openai/gpt-5:exacto",
		thinkingLevel: undefined,
	});
});

test("parses displayed model and usage independently", () => {
	const detail = parseDetail([
		"Agent: worker",
		"State: idle",
		"Model: gpt-4o-mini:off",
		"Last output: ACK",
		"Usage: ↑21782 ↓116 $0.0021 (4 turns)",
	].join("\n"));
	assert.equal(detail.model, "gpt-4o-mini");
	assert.equal(detail.thinkingLevel, "off");
	assert.equal(detail.inputTotal, 21782);
	assert.equal(detail.output, 116);
	assert.equal(detail.turns, 4);
});
