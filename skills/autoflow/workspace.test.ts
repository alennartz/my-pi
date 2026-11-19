import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	checkWorkspaceGit,
	checkWorkspaceRows,
	createGitProbe,
	parseWorkspaceRows,
	type GitProbe,
} from "./workspace.ts";

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `autoflow-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function plan(body: string): string {
	return `# Plan: topic\n\n## Context\n\nText.\n\n${body}\n\n## Steps\n\n### Step 1\n\nText.\n`;
}

const healthyTable = `## Workspace

| repo  | path | shape   | test-base | impl-base |
|-------|------|---------|-----------|-----------|
| api   | /a   | symlink | 9b6acb4   | 51dcacd   |
| web   | /b   | local   |           |           |
`;

const probe = (overrides: Partial<GitProbe> = {}): GitProbe => ({
	isCommit: () => true,
	headReachable: () => true,
	...overrides,
});

describe("parseWorkspaceRows", () => {
	it("returns null when the plan has no workspace section", () => {
		expect(parseWorkspaceRows(plan("## Tests\n\nText."))).toBeNull();
	});

	it("reads rows with and without bases", () => {
		expect(parseWorkspaceRows(plan(healthyTable))).toEqual([
			{ repo: "api", path: "/a", shape: "symlink", testBase: "9b6acb4", implBase: "51dcacd" },
			{ repo: "web", path: "/b", shape: "local", testBase: undefined, implBase: undefined },
		]);
	});

	it("keeps a path that contains spaces", () => {
		const rows = parseWorkspaceRows(plan(`## Workspace

| repo | path                | shape | test-base | impl-base |
|------|---------------------|-------|-----------|-----------|
| hub  | /home/u/Ide hub/api | local |           |           |
`));
		expect(rows).toEqual([
			{ repo: "hub", path: "/home/u/Ide hub/api", shape: "local", testBase: undefined, implBase: undefined },
		]);
	});

	it("rejects a row with a missing column", () => {
		const rows = parseWorkspaceRows(plan(`## Workspace

| repo | path | shape   | test-base |
|------|------|---------|-----------|
| api  | /a   | symlink | 9b6acb4   |
`));
		expect(typeof rows).toBe("string");
	});

	it("rejects an unknown shape", () => {
		const rows = parseWorkspaceRows(plan(`## Workspace

| repo | path | shape  | test-base | impl-base |
|------|------|--------|-----------|-----------|
| api  | /a   | worktr |           |           |
`));
		expect(rows).toMatch(/shape/);
	});

	it("rejects a repeated repository id", () => {
		const rows = parseWorkspaceRows(plan(`## Workspace

| repo | path | shape | test-base | impl-base |
|------|------|-------|-----------|-----------|
| api  | /a   | local |           |           |
| api  | /b   | local |           |           |
`));
		expect(typeof rows).toBe("string");
	});

	it("stops the section at the next heading", () => {
		const rows = parseWorkspaceRows(plan(`${healthyTable}\n## Steps

| not | a | workspace | row | here |
`));
		expect(Array.isArray(rows) && rows.length === 2).toBe(true);
	});
});

describe("checkWorkspaceRows", () => {
	it("is inert without a section", () => {
		expect(checkWorkspaceRows(null)).toBeNull();
	});

	it("fails a row whose path does not resolve", () => {
		const result = checkWorkspaceRows([
			{ repo: "api", path: join(testDir, "missing"), shape: "local" },
		]);
		expect(result?.passed).toBe(false);
		expect(result?.detail).toMatch(/api/);
	});

	it("passes rows whose paths resolve", () => {
		const repoPath = join(testDir, "api");
		mkdirSync(repoPath);
		const result = checkWorkspaceRows([{ repo: "api", path: repoPath, shape: "local" }]);
		expect(result?.passed).toBe(true);
	});

	it("reports a malformed section", () => {
		const result = checkWorkspaceRows("each repository id appears only once");
		expect(result?.passed).toBe(false);
		expect(result?.detail).toMatch(/invalid/);
	});
});

describe("checkWorkspaceGit", () => {
	it("rejects a base that is not a commit", () => {
		const result = checkWorkspaceGit(
			[{ repo: "api", path: testDir, shape: "local", testBase: "abc1234" }],
			probe({ isCommit: () => false }),
		);
		expect(result.passed).toBe(false);
		expect(result.detail).toMatch(/test-base/);
	});

	it("rejects a detached worktree member with no branch", () => {
		const result = checkWorkspaceGit(
			[{ repo: "api", path: testDir, shape: "worktree-detached" }],
			probe({ headReachable: () => false }),
		);
		expect(result.passed).toBe(false);
		expect(result.detail).toMatch(/disbanded/);
	});

	it("accepts a detached worktree member that sits on a branch", () => {
		const result = checkWorkspaceGit(
			[{ repo: "api", path: testDir, shape: "worktree-detached" }],
			probe(),
		);
		expect(result.passed).toBe(true);
	});

	it("accepts rows with no bases", () => {
		const result = checkWorkspaceGit([{ repo: "api", path: testDir, shape: "symlink" }], probe());
		expect(result.passed).toBe(true);
	});
});

const gitAvailable = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!gitAvailable)("createGitProbe", () => {
	function initRepo(path: string): string {
		mkdirSync(path, { recursive: true });
		execFileSync("git", ["-C", path, "init", "-q"]);
		execFileSync("git", [
			"-C", path,
			"-c", "user.email=t@example.com",
			"-c", "user.name=T",
			"commit", "-q", "--allow-empty", "-m", "init",
		]);
		return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
	}

	it("recognises a real commit and rejects a fabricated hash", () => {
		const repoPath = join(testDir, "repo");
		const head = initRepo(repoPath);
		const git = createGitProbe();
		expect(git.isCommit(repoPath, head)).toBe(true);
		expect(git.isCommit(repoPath, "0000000")).toBe(false);
	});

	it("treats a detached HEAD as safe while a branch still holds its commit", () => {
		const repoPath = join(testDir, "repo");
		initRepo(repoPath);
		const git = createGitProbe();
		expect(git.headReachable(repoPath)).toBe(true);

		execFileSync("git", ["-C", repoPath, "checkout", "-q", "--detach"]);
		expect(git.headReachable(repoPath)).toBe(true);
	});

	it("reports a detached commit that no branch holds", () => {
		const repoPath = join(testDir, "repo");
		initRepo(repoPath);
		execFileSync("git", ["-C", repoPath, "checkout", "-q", "--detach"]);
		execFileSync("git", [
			"-C", repoPath,
			"-c", "user.email=t@example.com",
			"-c", "user.name=T",
			"commit", "-q", "--allow-empty", "-m", "work on a detached head",
		]);
		expect(createGitProbe().headReachable(repoPath)).toBe(false);
	});
});
