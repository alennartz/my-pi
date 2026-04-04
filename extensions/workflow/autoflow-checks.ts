/**
 * Transition validation for the autoflow pipeline.
 *
 * Implements the artifact check table defined in the autoflow architecture:
 * each autonomous phase has a validation check that the primary agent runs
 * after a subagent completes, before proceeding to the next phase.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Result of checking whether a phase's expected artifact is present and valid.
 */
export interface TransitionCheckResult {
	/** Whether the artifact check passed */
	passed: boolean;
	/** Human-readable description of what was checked and the outcome */
	detail: string;
}

/**
 * Autonomous phases that have defined transition checks.
 * Brainstorm and architect are interactive and don't have artifact checks.
 */
export type CheckablePhase =
	| "test-write"
	| "test-review"
	| "impl-plan"
	| "implement"
	| "review"
	| "handle-review"
	| "cleanup";

const CHECKABLE_PHASES = new Set<string>([
	"test-write",
	"test-review",
	"impl-plan",
	"implement",
	"review",
	"handle-review",
	"cleanup",
]);

/**
 * Check whether a phase's expected artifact is present and valid.
 *
 * Returns null for phases without defined checks (brainstorm, architect,
 * or unrecognized phase names). Returns a TransitionCheckResult for
 * checkable phases.
 *
 * The checks validate:
 * - test-write: plan file contains a ## Tests section
 * - test-review: test review file (docs/reviews/<topic>-tests.md) exists
 * - impl-plan: plan file contains a ## Steps section
 * - implement: plan file has no pending steps (all Status fields are "done")
 * - review: review file (docs/reviews/<topic>.md) exists
 * - handle-review: review file (docs/reviews/<topic>.md) exists
 * - cleanup: working artifacts (plan file, review files) have been cleaned up
 */
export function checkTransitionArtifact(
	phase: string,
	topic: string,
	cwd: string,
): TransitionCheckResult | null {
	if (!CHECKABLE_PHASES.has(phase)) {
		return null;
	}

	const planPath = join(cwd, "docs/plans", `${topic}.md`);
	const reviewPath = join(cwd, "docs/reviews", `${topic}.md`);
	const testReviewPath = join(cwd, "docs/reviews", `${topic}-tests.md`);

	switch (phase) {
		case "test-write": {
			if (!existsSync(planPath)) {
				return { passed: false, detail: `Plan file does not exist: docs/plans/${topic}.md` };
			}
			const content = readFileSync(planPath, "utf-8");
			if (/^## Tests$/m.test(content)) {
				return { passed: true, detail: `Plan file contains ## Tests section.` };
			}
			return { passed: false, detail: `Plan file exists but does not contain a ## Tests section.` };
		}

		case "test-review": {
			if (existsSync(testReviewPath)) {
				return { passed: true, detail: `Test review file exists: docs/reviews/${topic}-tests.md` };
			}
			return { passed: false, detail: `Test review file not found: docs/reviews/${topic}-tests.md` };
		}

		case "impl-plan": {
			if (!existsSync(planPath)) {
				return { passed: false, detail: `Plan file does not exist: docs/plans/${topic}.md` };
			}
			const content = readFileSync(planPath, "utf-8");
			if (/^## Steps$/m.test(content)) {
				return { passed: true, detail: `Plan file contains ## Steps section.` };
			}
			return { passed: false, detail: `Plan file exists but does not contain a ## Steps section.` };
		}

		case "implement": {
			if (!existsSync(planPath)) {
				return { passed: false, detail: `Plan file does not exist: docs/plans/${topic}.md` };
			}
			const content = readFileSync(planPath, "utf-8");
			if (!/^## Steps$/m.test(content)) {
				return { passed: false, detail: `Plan file does not contain a ## Steps section.` };
			}
			const statusMatches = content.match(/^\*\*Status:\*\*\s*(.+)$/gm);
			if (!statusMatches || statusMatches.length === 0) {
				return { passed: false, detail: `No step status fields found in the ## Steps section.` };
			}
			const allDone = statusMatches.every((line) => /^\*\*Status:\*\*\s*done\s*$/.test(line));
			if (allDone) {
				return { passed: true, detail: `All ${statusMatches.length} step(s) have status: done.` };
			}
			const pendingCount = statusMatches.filter((line) => !/^\*\*Status:\*\*\s*done\s*$/.test(line)).length;
			return { passed: false, detail: `${pendingCount} of ${statusMatches.length} step(s) still pending.` };
		}

		case "review": {
			if (existsSync(reviewPath)) {
				return { passed: true, detail: `Review file exists: docs/reviews/${topic}.md` };
			}
			return { passed: false, detail: `Review file not found: docs/reviews/${topic}.md` };
		}

		case "handle-review": {
			if (existsSync(reviewPath)) {
				return { passed: true, detail: `Review file exists: docs/reviews/${topic}.md` };
			}
			return { passed: false, detail: `Review file not found: docs/reviews/${topic}.md` };
		}

		case "cleanup": {
			const remaining: string[] = [];
			if (existsSync(planPath)) remaining.push(`docs/plans/${topic}.md`);
			if (existsSync(reviewPath)) remaining.push(`docs/reviews/${topic}.md`);
			if (existsSync(testReviewPath)) remaining.push(`docs/reviews/${topic}-tests.md`);
			if (remaining.length === 0) {
				return { passed: true, detail: `All working artifacts have been cleaned up.` };
			}
			return { passed: false, detail: `Working artifacts still present: ${remaining.join(", ")}` };
		}

		default:
			return null;
	}
}
