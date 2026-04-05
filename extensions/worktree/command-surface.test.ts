import { describe, expect, it } from "vitest";
import { DEFAULT_MERGE_TARGET } from "./contracts.ts";
import {
	buildCleanupMergePrompt,
	getWorktreeArgumentCompletions,
	parseWorktreeCommand,
	resolveWorktreePath,
} from "./command-surface.ts";

describe("/worktree command surface", () => {
	it("parses create requests with a required branch name and optional base branch", () => {
		expect(parseWorktreeCommand("create feature/worktree")).toEqual({
			ok: true,
			command: {
				kind: "create",
				request: {
					branchName: "feature/worktree",
					baseBranch: undefined,
				},
			},
		});

		expect(parseWorktreeCommand("create feature/worktree release/1.2")).toEqual({
			ok: true,
			command: {
				kind: "create",
				request: {
					branchName: "feature/worktree",
					baseBranch: "release/1.2",
				},
			},
		});
	});

	it("rejects malformed create invocations before any worktree logic runs", () => {
		expect(parseWorktreeCommand("create")).toEqual({
			ok: false,
			message: "Usage: /worktree create <branch-name> [base-branch]",
		});

		expect(parseWorktreeCommand("create feature base extra")).toEqual({
			ok: false,
			message: "Usage: /worktree create <branch-name> [base-branch]",
		});
	});

	it("defaults cleanup to main when no merge target is provided", () => {
		expect(parseWorktreeCommand("cleanup")).toEqual({
			ok: true,
			command: {
				kind: "cleanup",
				request: {
					mergeTarget: DEFAULT_MERGE_TARGET,
				},
			},
		});
	});

	it("rejects malformed cleanup invocations before any merge work begins", () => {
		expect(parseWorktreeCommand("cleanup main extra")).toEqual({
			ok: false,
			message: "Usage: /worktree cleanup [merge-target]",
		});
	});

	it("suggests subcommands before a worktree action is chosen", () => {
		expect(getWorktreeArgumentCompletions("", ["main", "release"])).toEqual([
			{ value: "create", label: "create" },
			{ value: "cleanup", label: "cleanup" },
		]);

		expect(getWorktreeArgumentCompletions("cl", ["main", "release"])).toEqual([
			{ value: "cleanup", label: "cleanup" },
		]);
	});

	it("suggests branch names for create branch and base-branch positions", () => {
		const branches = ["main", "release/1.2", "feature/worktree"];

		expect(getWorktreeArgumentCompletions("create ", branches)).toEqual([
			{ value: "main", label: "main" },
			{ value: "release/1.2", label: "release/1.2" },
			{ value: "feature/worktree", label: "feature/worktree" },
		]);

		expect(getWorktreeArgumentCompletions("create feature/worktree re", branches)).toEqual([
			{ value: "release/1.2", label: "release/1.2" },
		]);
	});

	it("suggests branch names for cleanup merge targets", () => {
		const branches = ["main", "release/1.2", "staging"];

		expect(getWorktreeArgumentCompletions("cleanup ", branches)).toEqual([
			{ value: "main", label: "main" },
			{ value: "release/1.2", label: "release/1.2" },
			{ value: "staging", label: "staging" },
		]);

		expect(getWorktreeArgumentCompletions("cleanup st", branches)).toEqual([
			{ value: "staging", label: "staging" },
		]);
	});

	it("builds worktree paths under the centralized git-worktrees home directory", () => {
		expect(resolveWorktreePath("/home/alenna", "my-pi", "feature/worktree")).toBe(
			"/home/alenna/.git-worktrees/my-pi/feature/worktree",
		);
	});

	it("builds a merge instruction that tells the agent to merge the current branch into the chosen target", () => {
		const prompt = buildCleanupMergePrompt("feature/worktree", "release/1.2");
		expect(prompt).toContain("feature/worktree");
		expect(prompt).toContain("release/1.2");
		expect(prompt).toContain("bash tool calls");
	});
});
