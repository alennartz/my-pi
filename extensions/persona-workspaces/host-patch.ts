/**
 * Self-healing host patch: teach the running pi's prompt builder to accept
 * `sections.preamble` as an override of the default identity sentence.
 *
 * pi appends custom prompt sections after the working-directory line and
 * throws on a section named `preamble`, so an extension cannot displace the
 * default identity through the public prompt options. This module rewrites
 * the host's prompt-builder artifacts in place — three exact-string touches
 * inside `buildSystemPromptSections`:
 *
 * - `dist/core/system-prompt.js` for the unbundled SDK module,
 * - the matching minified module under `dist/bundle/chunks/` for the CLI.
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
 * Version coupling: every transform matches exact snippets from pi's
 * unbundled or minified bundle output. A pi release that reshapes any
 * snippet makes the attempt "incompatible" — never a partial or blind write —
 * and the stacked fallback keeps the persona working until the snippets are
 * re-aligned.
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

const BUNDLE_GUARD =
	'if(!SYSTEM_PROMPT_SECTION_NAME.test(name)||name==="preamble")throw new Error(`Invalid system prompt section name: ${name}`);';
const BUNDLE_GUARD_PATCHED =
	'if(!SYSTEM_PROMPT_SECTION_NAME.test(name))throw new Error(`Invalid system prompt section name: ${name}`);';
const BUNDLE_ASSIGNMENT = `promptSections.preamble="${DEFAULT_SENTENCE}";`;
const BUNDLE_ASSIGNMENT_PATCHED = `promptSections.preamble=customSections.preamble??"${DEFAULT_SENTENCE}";`;
const BUNDLE_MERGE_LOOP = "content&&(promptSections[name]=content);";
const BUNDLE_MERGE_LOOP_PATCHED = 'content&&name!=="preamble"&&(promptSections[name]=content);';
const BUNDLE_FUNCTION_START = "function buildSystemPromptSections(";
const BUNDLE_FUNCTION_END = "function buildSystemPromptState(";
const BUNDLE_ERROR = "Invalid system prompt section name";

type SourcePatchOutcome =
	| { kind: "already-patched" }
	| { kind: "patched"; source: string }
	| { kind: "incompatible"; reason: string };

type SourceTouch = readonly [from: string, to: string];

const CORE_TOUCHES: readonly SourceTouch[] = [
	[GUARD, GUARD_PATCHED],
	[PREAMBLE_ASSIGNMENT, PREAMBLE_ASSIGNMENT_PATCHED],
	[MERGE_LOOP, MERGE_LOOP_PATCHED],
];

const BUNDLE_TOUCHES: readonly SourceTouch[] = [
	[BUNDLE_GUARD, BUNDLE_GUARD_PATCHED],
	[BUNDLE_ASSIGNMENT, BUNDLE_ASSIGNMENT_PATCHED],
	[BUNDLE_MERGE_LOOP, BUNDLE_MERGE_LOOP_PATCHED],
];

function occurrenceCount(source: string, snippet: string): number {
	let count = 0;
	let from = 0;
	while (true) {
		const index = source.indexOf(snippet, from);
		if (index === -1) return count;
		count += 1;
		from = index + snippet.length;
	}
}

/** Apply one exact-string patch set without accepting a partial marker. */
function applyExactTouches(source: string, touches: readonly SourceTouch[]): SourcePatchOutcome {
	const patchedCounts = touches.map(([, to]) => occurrenceCount(source, to));
	const originalCounts = touches.map(([from]) => occurrenceCount(source, from));
	if (
		patchedCounts.every((count) => count === 1) &&
		originalCounts.every((count) => count === 0)
	) {
		return { kind: "already-patched" };
	}
	if (patchedCounts.some((count) => count > 0) || source.includes("customSections.preamble")) {
		return { kind: "incompatible", reason: "expected snippets are partially patched" };
	}

	let patched = source;
	for (const [from, to] of touches) {
		const count = occurrenceCount(patched, from);
		if (count === 0) {
			return {
				kind: "incompatible",
				reason: `expected snippet not found: ${JSON.stringify(from.slice(0, 48))}`,
			};
		}
		if (count !== 1) {
			return { kind: "incompatible", reason: "expected snippet occurs more than once" };
		}
		const first = patched.indexOf(from);
		patched = patched.slice(0, first) + to + patched.slice(first + from.length);
	}
	return { kind: "patched", source: patched };
}

/**
 * Apply the three touches to the unbundled prompt module. Pure and
 * exact-string: every expected snippet must occur exactly once, or the source
 * is reported incompatible and nothing is produced.
 */
export function patchPreambleOverrideSource(source: string): SourcePatchOutcome {
	return applyExactTouches(source, CORE_TOUCHES);
}

/**
 * Apply the three touches to the minified prompt builder embedded in pi's CLI
 * bundle. Restricting the replacements to the named function prevents a
 * compact merge-loop snippet elsewhere in the bundle from being changed.
 */
export function patchPreambleOverrideBundleSource(source: string): SourcePatchOutcome {
	if (occurrenceCount(source, BUNDLE_FUNCTION_START) !== 1) {
		return { kind: "incompatible", reason: "bundled prompt builder was not found exactly once" };
	}
	const start = source.indexOf(BUNDLE_FUNCTION_START);
	const end = source.indexOf(BUNDLE_FUNCTION_END, start + BUNDLE_FUNCTION_START.length);
	if (end === -1) {
		return { kind: "incompatible", reason: "bundled prompt builder end was not found" };
	}
	const body = source.slice(start, end);
	const outcome = applyExactTouches(body, BUNDLE_TOUCHES);
	if (outcome.kind !== "patched") return outcome;
	return {
		kind: "patched",
		source: source.slice(0, start) + outcome.source + source.slice(end),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type PatchTarget = {
	path: string;
	patch: (source: string) => SourcePatchOutcome;
	bundle: boolean;
};

type PreparedPatch = PatchTarget & {
	source: string;
	outcome: SourcePatchOutcome;
};

function patchTargets(piPackageDir: string): PatchTarget[] {
	const targets: PatchTarget[] = [
		{
			path: path.join(piPackageDir, "dist", "core", "system-prompt.js"),
			patch: patchPreambleOverrideSource,
			bundle: false,
		},
	];
	const bundleDir = path.join(piPackageDir, "dist", "bundle");
	const bundleDirs = [bundleDir, path.join(bundleDir, "chunks")];
	const seen = new Set<string>();
	for (const directory of bundleDirs) {
		try {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
				const target = path.join(directory, entry.name);
				if (seen.has(target)) continue;
				seen.add(target);
				targets.push({ path: target, patch: patchPreambleOverrideBundleSource, bundle: true });
			}
		} catch {
			// A host without this bundle directory has no targets here.
		}
	}
	return targets;
}

function isBundledPromptSource(source: string): boolean {
	return (
		source.includes(BUNDLE_ERROR) &&
		(source.includes(BUNDLE_GUARD) || source.includes(BUNDLE_GUARD_PATCHED))
	);
}

function writeAtomically(target: string, source: string, index: number): string | undefined {
	const temp = `${target}.persona-patch-${process.pid}-${index}.tmp`;
	try {
		fs.writeFileSync(temp, source);
		fs.renameSync(temp, target);
		return undefined;
	} catch (error) {
		try {
			fs.unlinkSync(temp);
		} catch {
			// The rename failed; the temp cleanup failing too changes nothing.
		}
		return `could not write ${target}: ${errorMessage(error)}`;
	}
}

/**
 * Ensure every prompt builder shipped by the host accepts `sections.preamble`.
 * The standard Node package has both an unbundled SDK module and a minified CLI
 * chunk, so both are checked and patched. Never throws: every failure comes
 * back as a status.
 */
export function ensurePreamblePatch(piPackageDir: string): PreamblePatchStatus {
	const prepared: PreparedPatch[] = [];
	for (const target of patchTargets(piPackageDir)) {
		let source: string;
		try {
			source = fs.readFileSync(target.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { kind: "failed", reason: `could not read ${target.path}: ${errorMessage(error)}` };
		}
		if (target.bundle && !isBundledPromptSource(source)) {
			continue;
		}
		prepared.push({ ...target, source, outcome: target.patch(source) });
	}

	if (prepared.length === 0) {
		return {
			kind: "failed",
			reason: `could not find a supported prompt builder under ${piPackageDir}`,
		};
	}
	const incompatible = prepared.find((target) => target.outcome.kind === "incompatible");
	if (incompatible?.outcome.kind === "incompatible") {
		return {
			kind: "incompatible",
			reason: `${incompatible.path}: ${incompatible.outcome.reason}`,
		};
	}

	const changed = prepared.filter(
		(target): target is PreparedPatch & { outcome: { kind: "patched"; source: string } } =>
			target.outcome.kind === "patched",
	);
	if (changed.length === 0) return { kind: "already-patched" };
	for (const [index, target] of changed.entries()) {
		const failure = writeAtomically(target.path, target.outcome.source, index);
		if (failure) return { kind: "failed", reason: failure };
	}
	return { kind: "patched" };
}
