import test from "node:test";
import assert from "node:assert/strict";
import { hasGenericPreamble, thinkingLevelCheck } from "./run.mjs";

test("recognizes both host generic preamble variants", () => {
	assert.equal(hasGenericPreamble("You are a coding assistant running inside pi."), true);
	assert.equal(hasGenericPreamble("You are an expert coding assistant operating inside pi."), true);
	assert.equal(hasGenericPreamble("You are BenchLead. PREAMBLE-R1."), false);
});

test("accepts an effective thinking level after model capability clamping", () => {
	assert.equal(thinkingLevelCheck("off", ["off"]), true);
	assert.equal(thinkingLevelCheck("high", ["off", "low", "medium", "high"]), true);
	assert.equal(thinkingLevelCheck("high", ["off"]), false);
});
