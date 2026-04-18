/**
 * Autoflow phase transition validator.
 *
 * Usage:
 *   npx tsx skills/autoflow/check-transition.ts <phase> <topic>
 *
 * Run from the repo root — artifact paths are resolved against process.cwd().
 *
 * Exit codes:
 *   0  passed
 *   1  failed (artifact missing / malformed)
 *   2  usage error / unknown phase
 *
 * Phases covered: test-write, test-review, impl-plan, implement, review,
 *                 handle-review, manual-test, cleanup.
 * brainstorm and architect are interactive and have no check.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Result {
	passed: boolean;
	detail: string;
}

export function checkTransitionArtifact(phase: string, topic: string, cwd: string): Result | null {
	const planPath = join(cwd, "docs/plans", `${topic}.md`);
	const reviewPath = join(cwd, "docs/reviews", `${topic}.md`);
	const testReviewPath = join(cwd, "docs/reviews", `${topic}-tests.md`);
	const manualTestPath = join(cwd, "docs/manual-tests", `${topic}.md`);

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
			const stepsStart = content.match(/^## Steps$/m);
			if (!stepsStart || stepsStart.index === undefined) {
				return { passed: false, detail: `Plan file does not contain a ## Steps section.` };
			}
			const stepsContent = content.slice(stepsStart.index);
			const nextHeading = stepsContent.match(/\n## (?!#)/);
			const stepsSection =
				nextHeading && nextHeading.index !== undefined
					? stepsContent.slice(0, nextHeading.index)
					: stepsContent;
			const statusMatches = stepsSection.match(/^\*\*Status:\*\*\s*(.+)$/gm);
			if (!statusMatches || statusMatches.length === 0) {
				return { passed: false, detail: `No step status fields found in the ## Steps section.` };
			}
			const allDone = statusMatches.every((line) => /^\*\*Status:\*\*\s*done\s*$/.test(line));
			if (allDone) {
				return { passed: true, detail: `All ${statusMatches.length} step(s) have status: done.` };
			}
			const pendingCount = statusMatches.filter(
				(line) => !/^\*\*Status:\*\*\s*done\s*$/.test(line),
			).length;
			return {
				passed: false,
				detail: `${pendingCount} of ${statusMatches.length} step(s) still pending.`,
			};
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

		case "manual-test": {
			if (!existsSync(manualTestPath)) {
				return {
					passed: false,
					detail: `Manual test artifact not found: docs/manual-tests/${topic}.md`,
				};
			}
			const content = readFileSync(manualTestPath, "utf-8");
			if (!/^## Test Plan$/m.test(content)) {
				return {
					passed: false,
					detail: `Manual test artifact exists but does not contain a ## Test Plan section.`,
				};
			}
			if (!/^## Results$/m.test(content)) {
				return {
					passed: false,
					detail: `Manual test artifact exists but does not contain a ## Results section.`,
				};
			}
			return {
				passed: true,
				detail: `Manual test artifact exists with ## Test Plan and ## Results: docs/manual-tests/${topic}.md`,
			};
		}

		case "cleanup": {
			const remaining: string[] = [];
			if (existsSync(planPath)) remaining.push(`docs/plans/${topic}.md`);
			if (existsSync(reviewPath)) remaining.push(`docs/reviews/${topic}.md`);
			if (existsSync(testReviewPath)) remaining.push(`docs/reviews/${topic}-tests.md`);
			if (existsSync(manualTestPath)) remaining.push(`docs/manual-tests/${topic}.md`);
			if (remaining.length === 0) {
				return { passed: true, detail: `All working artifacts have been cleaned up.` };
			}
			return { passed: false, detail: `Working artifacts still present: ${remaining.join(", ")}` };
		}

		default:
			return null;
	}
}

// ── CLI entry ───────────────────────────────────────────────────────────
// Only runs when invoked as a script, not when imported by tests.
const invokedAsScript =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
	const USAGE = `Usage: npx tsx skills/autoflow/check-transition.ts <phase> <topic>

Exit codes: 0 passed, 1 failed, 2 usage error / unknown phase.

Phases: test-write, test-review, impl-plan, implement, review, handle-review, manual-test, cleanup.
(brainstorm and architect are interactive — no check.)`;

	const [, , phase, topic, ...extra] = process.argv;

	if (!phase || !topic || extra.length > 0) {
		console.error(USAGE);
		process.exit(2);
	}

	const result = checkTransitionArtifact(phase, topic, process.cwd());

	if (result === null) {
		console.error(`No transition check defined for phase: ${phase}`);
		console.error(USAGE);
		process.exit(2);
	}

	console.log(`${result.passed ? "PASS" : "FAIL"} [${phase}] ${result.detail}`);
	process.exit(result.passed ? 0 : 1);
}
