/**
 * Transition validation for the autoflow pipeline.
 *
 * Implements the artifact check table defined in the autoflow architecture:
 * each autonomous phase has a validation check that the primary agent runs
 * after a subagent completes, before proceeding to the next phase.
 */

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
 * - cleanup: working artifacts (plan, reviews) have been cleaned up
 */
export function checkTransitionArtifact(
	phase: string,
	topic: string,
	cwd: string,
): TransitionCheckResult | null {
	throw new Error("not implemented");
}
