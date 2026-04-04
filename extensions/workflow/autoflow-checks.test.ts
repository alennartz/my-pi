import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkTransitionArtifact } from "./autoflow-checks.js";

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `autoflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

/** Create the standard artifact directory structure */
function setupDirs() {
	mkdirSync(join(testDir, "docs/plans"), { recursive: true });
	mkdirSync(join(testDir, "docs/reviews"), { recursive: true });
	mkdirSync(join(testDir, "docs/decisions"), { recursive: true });
	mkdirSync(join(testDir, "docs/brainstorms"), { recursive: true });
}

// ─── Phases without checks ──────────────────────────────────────────────────

describe("phases without transition checks", () => {
	it("returns null for brainstorm", () => {
		expect(checkTransitionArtifact("brainstorm", "my-topic", testDir)).toBeNull();
	});

	it("returns null for architect", () => {
		expect(checkTransitionArtifact("architect", "my-topic", testDir)).toBeNull();
	});

	it("returns null for unrecognized phase names", () => {
		expect(checkTransitionArtifact("nonexistent-phase", "my-topic", testDir)).toBeNull();
	});
});

// ─── test-write: plan file contains ## Tests section ────────────────────────

describe("test-write transition check", () => {
	it("passes when the plan file contains a ## Tests section", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan: my-topic\n\n## Architecture\n\nSome architecture.\n\n## Tests\n\nSome test details.\n",
		);
		const result = checkTransitionArtifact("test-write", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("fails when the plan file does not exist", () => {
		setupDirs();
		const result = checkTransitionArtifact("test-write", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when the plan file exists but has no ## Tests section", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan: my-topic\n\n## Architecture\n\nSome architecture.\n",
		);
		const result = checkTransitionArtifact("test-write", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("provides a detail string describing the outcome", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan\n\n## Tests\n\nDetails.\n",
		);
		const result = checkTransitionArtifact("test-write", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(typeof result!.detail).toBe("string");
		expect(result!.detail.length).toBeGreaterThan(0);
	});
});

// ─── test-review: test review file exists ───────────────────────────────────

describe("test-review transition check", () => {
	it("passes when the test review file exists", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/reviews/my-topic-tests.md"),
			"# Test Review\n",
		);
		const result = checkTransitionArtifact("test-review", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("fails when the test review file does not exist", () => {
		setupDirs();
		const result = checkTransitionArtifact("test-review", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});
});

// ─── impl-plan: plan file contains ## Steps section ─────────────────────────

describe("impl-plan transition check", () => {
	it("passes when the plan file contains a ## Steps section", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan\n\n## Architecture\n\nArch.\n\n## Tests\n\nTests.\n\n## Steps\n\n### Step 1: Do a thing\n\n**Status:** not started\n",
		);
		const result = checkTransitionArtifact("impl-plan", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("fails when the plan file does not exist", () => {
		setupDirs();
		const result = checkTransitionArtifact("impl-plan", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when the plan file exists but has no ## Steps section", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan\n\n## Architecture\n\nArch.\n\n## Tests\n\nTests.\n",
		);
		const result = checkTransitionArtifact("impl-plan", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});
});

// ─── implement: plan file has no pending steps ──────────────────────────────

describe("implement transition check", () => {
	it("passes when all steps have Status: done", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			[
				"# Plan",
				"",
				"## Steps",
				"",
				"### Step 1: First thing",
				"",
				"Do the first thing.",
				"",
				"**Verify:** Check it.",
				"**Status:** done",
				"",
				"### Step 2: Second thing",
				"",
				"Do the second thing.",
				"",
				"**Verify:** Check it.",
				"**Status:** done",
				"",
			].join("\n"),
		);
		const result = checkTransitionArtifact("implement", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("fails when any step has a non-done status", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			[
				"# Plan",
				"",
				"## Steps",
				"",
				"### Step 1: First thing",
				"",
				"Do the first thing.",
				"",
				"**Verify:** Check it.",
				"**Status:** done",
				"",
				"### Step 2: Second thing",
				"",
				"Do the second thing.",
				"",
				"**Verify:** Check it.",
				"**Status:** in progress",
				"",
			].join("\n"),
		);
		const result = checkTransitionArtifact("implement", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when steps have not-started status", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			[
				"# Plan",
				"",
				"## Steps",
				"",
				"### Step 1: First thing",
				"",
				"**Verify:** Check it.",
				"**Status:** not started",
				"",
			].join("\n"),
		);
		const result = checkTransitionArtifact("implement", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when steps have blocked status", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			[
				"# Plan",
				"",
				"## Steps",
				"",
				"### Step 1: First thing",
				"",
				"**Verify:** Check it.",
				"**Status:** blocked — waiting on dependency",
				"",
			].join("\n"),
		);
		const result = checkTransitionArtifact("implement", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when the plan file does not exist", () => {
		setupDirs();
		const result = checkTransitionArtifact("implement", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when the plan file has no ## Steps section", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan\n\n## Architecture\n\nArch.\n",
		);
		const result = checkTransitionArtifact("implement", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});
});

// ─── review: review file exists ─────────────────────────────────────────────

describe("review transition check", () => {
	it("passes when the review file exists", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/reviews/my-topic.md"),
			"# Code Review\n\nFindings.\n",
		);
		const result = checkTransitionArtifact("review", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("fails when the review file does not exist", () => {
		setupDirs();
		const result = checkTransitionArtifact("review", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});
});

// ─── handle-review: review file exists ──────────────────────────────────────

describe("handle-review transition check", () => {
	it("passes when the review file exists", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/reviews/my-topic.md"),
			"# Code Review\n\nFindings addressed.\n",
		);
		const result = checkTransitionArtifact("handle-review", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("fails when the review file does not exist", () => {
		setupDirs();
		const result = checkTransitionArtifact("handle-review", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});
});

// ─── cleanup: working artifacts cleaned ─────────────────────────────────────

describe("cleanup transition check", () => {
	it("passes when plan and review files have all been removed", () => {
		setupDirs();
		// No plan file, no review files = working artifacts cleaned
		const result = checkTransitionArtifact("cleanup", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("fails when the plan file still exists", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan\n\n## Steps\n\nAll done.\n",
		);
		const result = checkTransitionArtifact("cleanup", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when the code review file still exists", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/reviews/my-topic.md"),
			"# Code Review\n",
		);
		const result = checkTransitionArtifact("cleanup", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("fails when the test review file still exists", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/reviews/my-topic-tests.md"),
			"# Test Review\n",
		);
		const result = checkTransitionArtifact("cleanup", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});
});

// ─── Result shape ───────────────────────────────────────────────────────────

describe("TransitionCheckResult shape", () => {
	it("always includes passed boolean and non-empty detail string", () => {
		setupDirs();
		writeFileSync(
			join(testDir, "docs/plans/my-topic.md"),
			"# Plan\n\n## Tests\n\nDetails.\n",
		);
		const result = checkTransitionArtifact("test-write", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(typeof result!.passed).toBe("boolean");
		expect(typeof result!.detail).toBe("string");
		expect(result!.detail.length).toBeGreaterThan(0);
	});

	it("includes non-empty detail string on failure", () => {
		setupDirs();
		const result = checkTransitionArtifact("test-write", "my-topic", testDir);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
		expect(result!.detail.length).toBeGreaterThan(0);
	});
});
