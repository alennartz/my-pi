import { describe, expect, it } from "vitest";

import { patchPreambleOverrideSource } from "./host-patch.ts";

const GUARD = `if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {`;
const PREAMBLE_ASSIGNMENT = `        promptSections.preamble =
            "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";`;
const MERGE_LOOP = `        if (content)
            promptSections[name] = content;`;

const FIXTURE = [GUARD, PREAMBLE_ASSIGNMENT, MERGE_LOOP].join("\n");

describe("patchPreambleOverrideSource", () => {
	it("applies all three touches to an unpatched source", () => {
		const outcome = patchPreambleOverrideSource(FIXTURE);
		assert(outcome.kind === "patched");
		expect(outcome.source).not.toContain('|| name === "preamble"');
		expect(outcome.source).toContain("customSections.preamble ??");
		expect(outcome.source).toContain('if (content && name !== "preamble")');
	});

	it("reports an already-patched source by its marker without touching it", () => {
		const patched = patchPreambleOverrideSource(FIXTURE);
		assert(patched.kind === "patched");
		expect(patchPreambleOverrideSource(patched.source)).toEqual({ kind: "already-patched" });
	});

	it("reports incompatible when a snippet is missing, producing nothing", () => {
		const outcome = patchPreambleOverrideSource(FIXTURE.replace(GUARD, "if (true) {"));
		assert(outcome.kind === "incompatible");
		expect(outcome.reason).toContain("expected snippet not found");
	});

	it("reports incompatible when a snippet occurs more than once", () => {
		const doubled = `${FIXTURE}\n${GUARD}`;
		const outcome = patchPreambleOverrideSource(doubled);
		assert(outcome.kind === "incompatible");
		expect(outcome.reason).toContain("more than once");
	});
});

function assert(condition: boolean): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
