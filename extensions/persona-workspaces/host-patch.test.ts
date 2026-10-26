import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	ensurePreamblePatch,
	patchPreambleOverrideBundleSource,
	patchPreambleOverrideSource,
} from "./host-patch.ts";

const GUARD = `if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {`;
const PREAMBLE_ASSIGNMENT = `        promptSections.preamble =
            "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";`;
const MERGE_LOOP = `        if (content)
            promptSections[name] = content;`;

const FIXTURE = [GUARD, PREAMBLE_ASSIGNMENT, MERGE_LOOP].join("\n");

const BUNDLE_GUARD =
	'if(!SYSTEM_PROMPT_SECTION_NAME.test(name)||name==="preamble")throw new Error(`Invalid system prompt section name: ${name}`);';
const BUNDLE_GUARD_PATCHED =
	'if(!SYSTEM_PROMPT_SECTION_NAME.test(name))throw new Error(`Invalid system prompt section name: ${name}`);';
const BUNDLE_ASSIGNMENT = `promptSections.preamble="You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";`;
const BUNDLE_ASSIGNMENT_PATCHED = `promptSections.preamble=customSections.preamble??"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";`;
const BUNDLE_MERGE_LOOP = "content&&(promptSections[name]=content);";
const BUNDLE_MERGE_LOOP_PATCHED = 'content&&name!=="preamble"&&(promptSections[name]=content);';
const BUNDLE_PREFIX = "function buildSystemPromptSections(input2){";
const BUNDLE_SUFFIX = "function buildSystemPromptState(input2){";
const BUNDLE_FIXTURE =
	BUNDLE_PREFIX +
	[BUNDLE_GUARD, BUNDLE_ASSIGNMENT, BUNDLE_MERGE_LOOP].join("") +
	BUNDLE_SUFFIX +
	"return sections;";

describe("patchPreambleOverrideSource", () => {
	it("applies all three touches to an unpatched source", () => {
		const outcome = patchPreambleOverrideSource(FIXTURE);
		assert(outcome.kind === "patched");
		expect(outcome.source).not.toContain('|| name === "preamble"');
		expect(outcome.source).toContain("customSections.preamble ??");
		expect(outcome.source).toContain('if (content && name !== "preamble")');
	});

	it("reports an already-patched source only when all touches are present", () => {
		const patched = patchPreambleOverrideSource(FIXTURE);
		assert(patched.kind === "patched");
		expect(patchPreambleOverrideSource(patched.source)).toEqual({ kind: "already-patched" });
	});

	it("reports incompatible when a snippet is missing, producing nothing", () => {
		const outcome = patchPreambleOverrideSource(FIXTURE.replace(GUARD, "if (true) {"));
		assert(outcome.kind === "incompatible");
		expect(outcome.reason).toContain("expected snippet not found");
	});

	it("reports incompatible for a partial patch marker", () => {
		const outcome = patchPreambleOverrideSource("customSections.preamble ??");
		assert(outcome.kind === "incompatible");
		expect(outcome.reason).toContain("partially patched");
	});

	it("reports incompatible when a snippet occurs more than once", () => {
		const doubled = `${FIXTURE}\n${GUARD}`;
		const outcome = patchPreambleOverrideSource(doubled);
		assert(outcome.kind === "incompatible");
		expect(outcome.reason).toContain("more than once");
	});
});

describe("patchPreambleOverrideBundleSource", () => {
	it("patches the minified prompt builder inside the CLI bundle", () => {
		const outcome = patchPreambleOverrideBundleSource(BUNDLE_FIXTURE);
		assert(outcome.kind === "patched");
		expect(outcome.source).toContain(BUNDLE_GUARD_PATCHED);
		expect(outcome.source).toContain(BUNDLE_ASSIGNMENT_PATCHED);
		expect(outcome.source).toContain(BUNDLE_MERGE_LOOP_PATCHED);
		expect(outcome.source).not.toContain(BUNDLE_GUARD);
	});

	it("reports an already-patched bundle without relying on one marker", () => {
		const patched = patchPreambleOverrideBundleSource(BUNDLE_FIXTURE);
		assert(patched.kind === "patched");
		expect(patchPreambleOverrideBundleSource(patched.source)).toEqual({ kind: "already-patched" });
	});
});

describe("ensurePreamblePatch", () => {
	it("patches both the library module and the bundled CLI module", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "persona-host-bundle-"));
		const coreDir = join(packageDir, "dist", "core");
		const chunksDir = join(packageDir, "dist", "bundle", "chunks");
		mkdirSync(coreDir, { recursive: true });
		mkdirSync(chunksDir, { recursive: true });
		writeFileSync(join(coreDir, "system-prompt.js"), FIXTURE);
		writeFileSync(join(chunksDir, "chunk-prompt.js"), BUNDLE_FIXTURE);

		expect(ensurePreamblePatch(packageDir)).toEqual({ kind: "patched" });
		expect(readFileSync(join(coreDir, "system-prompt.js"), "utf8")).toContain(
			"customSections.preamble ??",
		);
		expect(readFileSync(join(chunksDir, "chunk-prompt.js"), "utf8")).toContain(
			BUNDLE_ASSIGNMENT_PATCHED,
		);
		expect(ensurePreamblePatch(packageDir)).toEqual({ kind: "already-patched" });
	});

	it("repairs an unpatched bundle when the library module is already patched", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "persona-host-bundle-repair-"));
		const coreDir = join(packageDir, "dist", "core");
		const chunksDir = join(packageDir, "dist", "bundle", "chunks");
		mkdirSync(coreDir, { recursive: true });
		mkdirSync(chunksDir, { recursive: true });
		const patchedCore = patchPreambleOverrideSource(FIXTURE);
		assert(patchedCore.kind === "patched");
		writeFileSync(join(coreDir, "system-prompt.js"), patchedCore.source);
		writeFileSync(join(chunksDir, "chunk-prompt.js"), BUNDLE_FIXTURE);

		expect(ensurePreamblePatch(packageDir)).toEqual({ kind: "patched" });
		expect(readFileSync(join(chunksDir, "chunk-prompt.js"), "utf8")).toContain(
			BUNDLE_ASSIGNMENT_PATCHED,
		);
	});
});

function assert(condition: boolean): asserts condition {
	if (!condition) throw new Error("assertion failed");
}
