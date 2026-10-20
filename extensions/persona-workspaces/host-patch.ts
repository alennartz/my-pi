/**
 * Self-healing host patch: teach the running pi's prompt builder to accept
 * `sections.preamble` as an override of the default identity sentence.
 *
 * pi appends custom prompt sections after the working-directory line and
 * throws on a section named `preamble`, so an extension cannot displace the
 * default identity through the public prompt options. This module rewrites
 * the host's `dist/core/system-prompt.js` in place — three exact-string
 * touches inside `buildSystemPromptSections`:
 *
 * 1. drop the `preamble` rejection from the section-name validation,
 * 2. let `sections.preamble` override the default sentence when `customPrompt`
 *    is unset,
 * 3. keep the merge loop from re-assigning `preamble`, so an explicit
 *    `--system-prompt` (customPrompt) always outranks it.
 *
 * Applied at extension activation, once per host runtime directory, on every
 * pi process start. The write is atomic (temp file + rename) and idempotent.
 * The running process keeps its in-memory module: the patch activates from
 * the next session start, and persona-workspaces falls back to stacking the
 * persona as a plain custom section until then.
 *
 * Version coupling: every transform matches one exact snippet from pi
 * 1.3.0's dist output. A pi release that reshapes any snippet makes the
 * attempt "incompatible" — never a partial or blind write — and the stacked
 * fallback keeps the persona working until the snippets are re-aligned.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type PreamblePatchStatus =
	| { kind: "already-patched" }
	| { kind: "patched" }
	| { kind: "incompatible"; reason: string }
	| { kind: "failed"; reason: string };

const GUARD =
	'if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {';
const GUARD_PATCHED = "if (!SYSTEM_PROMPT_SECTION_NAME.test(name)) {";

const DEFAULT_SENTENCE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const PREAMBLE_ASSIGNMENT = `        promptSections.preamble =
            "${DEFAULT_SENTENCE}";`;
const PREAMBLE_ASSIGNMENT_PATCHED = `        promptSections.preamble =
            customSections.preamble ??
            "${DEFAULT_SENTENCE}";`;

const MERGE_LOOP = `        if (content)
            promptSections[name] = content;`;
const MERGE_LOOP_PATCHED = `        if (content && name !== "preamble")
            promptSections[name] = content;`;

/** Present in the source iff touch 2 was applied — the patch marker. */
const PATCHED_MARKER = "customSections.preamble ??";

/**
 * Apply the three touches to one module source. Pure and exact-string: every
 * expected snippet must occur exactly once, or the source is reported
 * incompatible and nothing is produced.
 */
export function patchPreambleOverrideSource(
	source: string,
): { kind: "already-patched" } | { kind: "patched"; source: string } | { kind: "incompatible"; reason: string } {
	if (source.includes(PATCHED_MARKER)) return { kind: "already-patched" };
	const touches: Array<[string, string]> = [
		[GUARD, GUARD_PATCHED],
		[PREAMBLE_ASSIGNMENT, PREAMBLE_ASSIGNMENT_PATCHED],
		[MERGE_LOOP, MERGE_LOOP_PATCHED],
	];
	let patched = source;
	for (const [from, to] of touches) {
		const first = patched.indexOf(from);
		if (first === -1) {
			return {
				kind: "incompatible",
				reason: `expected snippet not found: ${JSON.stringify(from.slice(0, 48))}`,
			};
		}
		if (patched.indexOf(from, first + 1) !== -1) {
			return { kind: "incompatible", reason: "expected snippet occurs more than once" };
		}
		patched = patched.slice(0, first) + to + patched.slice(first + from.length);
	}
	return { kind: "patched", source: patched };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Ensure the host runtime at `piPackageDir` accepts `sections.preamble`.
 * Reads `dist/core/system-prompt.js`, applies the transform when needed, and
 * writes atomically. Never throws: every failure comes back as a status.
 */
export function ensurePreamblePatch(piPackageDir: string): PreamblePatchStatus {
	const target = path.join(piPackageDir, "dist", "core", "system-prompt.js");
	let source: string;
	try {
		source = fs.readFileSync(target, "utf8");
	} catch (error) {
		return { kind: "failed", reason: `could not read ${target}: ${errorMessage(error)}` };
	}
	const outcome = patchPreambleOverrideSource(source);
	if (outcome.kind !== "patched") return outcome;
	const temp = `${target}.persona-patch-${process.pid}.tmp`;
	try {
		fs.writeFileSync(temp, outcome.source);
		fs.renameSync(temp, target);
	} catch (error) {
		try {
			fs.unlinkSync(temp);
		} catch {
			// The rename failed; the temp cleanup failing too changes nothing.
		}
		return { kind: "failed", reason: `could not write ${target}: ${errorMessage(error)}` };
	}
	return { kind: "patched" };
}
