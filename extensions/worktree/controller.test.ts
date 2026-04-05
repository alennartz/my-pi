import { describe, expect, it, vi } from "vitest";
import type { WorktreeDependencies, WorktreeInfo } from "./contracts.ts";
import { DEFAULT_MERGE_TARGET } from "./contracts.ts";
import { buildCleanupMergePrompt, resolveWorktreePath } from "./command-surface.ts";
import { createWorktreeController } from "./controller.ts";

function createDependencies() {
	const mainRepo: WorktreeInfo = {
		path: "/repo/main",
		branch: "main",
		isMain: true,
	};
	const currentWorktree: WorktreeInfo = {
		path: "/home/test/.git-worktrees/my-pi/feature/worktree",
		branch: "feature/worktree",
		isMain: false,
	};

	const dependencies: WorktreeDependencies = {
		env: {
			cwd: "/repo/main",
			homeDirectory: "/home/test",
			repoName: "my-pi",
			currentSessionFile: "/sessions/current.jsonl",
		},
		git: {
			listWorktrees: vi.fn(async () => [mainRepo]),
			getCurrentBranch: vi.fn(async () => "main"),
			getStatusPorcelain: vi.fn(async () => ""),
			stashPush: vi.fn(async () => true),
			stashPop: vi.fn(async () => undefined),
			addWorktree: vi.fn(async () => undefined),
			removeWorktree: vi.fn(async () => undefined),
			deleteBranch: vi.fn(async () => undefined),
		},
		sessions: {
			continueRecent: vi.fn(async () => "/sessions/worktree-recent.jsonl"),
			create: vi.fn(async () => "/sessions/new.jsonl"),
			forkFrom: vi.fn(async () => "/sessions/forked.jsonl"),
		},
		agent: {
			sendMergeInstruction: vi.fn(async () => undefined),
		},
		runtime: {
			chooseContextTransfer: vi.fn(async () => "fresh-session"),
			choosePendingChanges: vi.fn(async () => "leave-changes"),
			notify: vi.fn(),
			waitForIdle: vi.fn(async () => undefined),
			switchSession: vi.fn(async () => ({ cancelled: false })),
		},
	};

	return {
		dependencies,
		mainRepo,
		currentWorktree,
	};
}

describe("Worktree controller", () => {
	describe("create", () => {
		it("reuses the most recent session in an existing worktree without prompting for context transfer or stashing", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValueOnce([mainRepo, currentWorktree]);

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: currentWorktree.branch });

			expect(dependencies.sessions.continueRecent).toHaveBeenCalledWith(currentWorktree.path);
			expect(dependencies.runtime.chooseContextTransfer).not.toHaveBeenCalled();
			expect(dependencies.runtime.choosePendingChanges).not.toHaveBeenCalled();
			expect(dependencies.git.addWorktree).not.toHaveBeenCalled();
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/worktree-recent.jsonl");
		});

		it("creates a new worktree from the current branch when no base branch is provided and the user starts fresh", async () => {
			const { dependencies } = createDependencies();
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce("main");
			vi.mocked(dependencies.runtime.chooseContextTransfer).mockResolvedValueOnce("fresh-session");
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("");

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: "feature/worktree" });

			const worktreePath = resolveWorktreePath("/home/test", "my-pi", "feature/worktree");
			expect(dependencies.git.addWorktree).toHaveBeenCalledWith({
				cwd: "/repo/main",
				path: worktreePath,
				branchName: "feature/worktree",
				baseBranch: "main",
			});
			expect(dependencies.sessions.create).toHaveBeenCalledWith(worktreePath);
			expect(dependencies.sessions.forkFrom).not.toHaveBeenCalled();
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/new.jsonl");
		});

		it("stashes tracked changes before worktree creation and reapplies them in the new worktree when the user brings changes", async () => {
			const { dependencies } = createDependencies();
			vi.mocked(dependencies.runtime.chooseContextTransfer).mockResolvedValueOnce("bring-context");
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce(" M extensions/worktree/index.ts\n");
			vi.mocked(dependencies.runtime.choosePendingChanges).mockResolvedValueOnce("bring-changes");
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce("main");

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: "feature/worktree", baseBranch: "release/1.2" });

			const worktreePath = resolveWorktreePath("/home/test", "my-pi", "feature/worktree");
			expect(dependencies.git.stashPush).toHaveBeenCalledWith("/repo/main");
			expect(dependencies.git.addWorktree).toHaveBeenCalledWith({
				cwd: "/repo/main",
				path: worktreePath,
				branchName: "feature/worktree",
				baseBranch: "release/1.2",
			});
			expect(dependencies.git.stashPop).toHaveBeenCalledWith(worktreePath);
			expect(dependencies.sessions.forkFrom).toHaveBeenCalledWith("/sessions/current.jsonl", worktreePath);
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/forked.jsonl");
		});
	});

	describe("cleanup", () => {
		it("asks the agent to merge into main, waits for idle, and returns control when the worktree stays dirty after merge", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			dependencies.env.cwd = currentWorktree.path;
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce(currentWorktree.branch);
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValueOnce([mainRepo, currentWorktree]);
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("UU extensions/worktree/index.ts\n");

			const controller = createWorktreeController(dependencies);
			await controller.cleanup({ mergeTarget: DEFAULT_MERGE_TARGET });

			expect(dependencies.agent.sendMergeInstruction).toHaveBeenCalledWith(
				buildCleanupMergePrompt(currentWorktree.branch, DEFAULT_MERGE_TARGET),
			);
			expect(dependencies.runtime.waitForIdle).toHaveBeenCalled();
			expect(dependencies.runtime.notify).toHaveBeenCalled();
			expect(dependencies.git.removeWorktree).not.toHaveBeenCalled();
			expect(dependencies.git.deleteBranch).not.toHaveBeenCalled();
		});

		it("removes the worktree, deletes the branch with -d semantics, and switches to a fresh session in the main repo when cleanup finishes cleanly", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			dependencies.env.cwd = currentWorktree.path;
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce(currentWorktree.branch);
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValueOnce([mainRepo, currentWorktree]);
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("");
			vi.mocked(dependencies.sessions.create).mockResolvedValueOnce("/sessions/back-in-main.jsonl");

			const controller = createWorktreeController(dependencies);
			await controller.cleanup({ mergeTarget: "release/1.2" });

			expect(dependencies.git.removeWorktree).toHaveBeenCalledWith({
				cwd: mainRepo.path,
				worktreePath: currentWorktree.path,
			});
			expect(dependencies.git.deleteBranch).toHaveBeenCalledWith({
				cwd: mainRepo.path,
				branchName: currentWorktree.branch,
				force: false,
			});
			expect(dependencies.sessions.create).toHaveBeenCalledWith(mainRepo.path);
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/back-in-main.jsonl");
		});
	});
});
