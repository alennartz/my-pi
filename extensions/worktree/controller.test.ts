import { describe, expect, it, vi } from "vitest";
import type { WorktreeDependencies, WorktreeInfo } from "./contracts.ts";
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
			branchExists: vi.fn(async () => false),
			addWorktree: vi.fn(async () => undefined),
			removeWorktree: vi.fn(async () => undefined),
			deleteBranch: vi.fn(async () => undefined),
			isAncestor: vi.fn(async () => true),
			detectDefaultBranch: vi.fn(async () => "main"),
		},
		sessions: {
			continueRecent: vi.fn(async () => "/sessions/worktree-recent.jsonl"),
			create: vi.fn(async () => "/sessions/new.jsonl"),
			forkFrom: vi.fn(async () => "/sessions/forked.jsonl"),
			discard: vi.fn(async () => undefined),
		},
		agent: {
			sendMergeInstruction: vi.fn(async () => undefined),
		},
		runtime: {
			chooseContextTransfer: vi.fn(async () => "fresh-session"),
			choosePendingChanges: vi.fn(async () => "leave-changes"),
			notify: vi.fn(),
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

		it("falls back to creating a fresh session when an existing worktree has no recent persisted session", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValueOnce([mainRepo, currentWorktree]);
			vi.mocked(dependencies.sessions.continueRecent).mockResolvedValueOnce(undefined);

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: currentWorktree.branch });

			expect(dependencies.sessions.continueRecent).toHaveBeenCalledWith(currentWorktree.path);
			expect(dependencies.sessions.create).toHaveBeenCalledWith(currentWorktree.path);
			expect(dependencies.runtime.chooseContextTransfer).not.toHaveBeenCalled();
			expect(dependencies.runtime.choosePendingChanges).not.toHaveBeenCalled();
			expect(dependencies.git.addWorktree).not.toHaveBeenCalled();
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/new.jsonl");
		});

		it("stops after requesting the resume-session switch when the runtime reports that the switch was cancelled", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValueOnce([mainRepo, currentWorktree]);
			vi.mocked(dependencies.runtime.switchSession).mockResolvedValueOnce({ cancelled: true });

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: currentWorktree.branch });

			expect(dependencies.sessions.continueRecent).toHaveBeenCalledWith(currentWorktree.path);
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/worktree-recent.jsonl");
			expect(dependencies.sessions.create).not.toHaveBeenCalled();
			expect(dependencies.runtime.chooseContextTransfer).not.toHaveBeenCalled();
			expect(dependencies.runtime.choosePendingChanges).not.toHaveBeenCalled();
			expect(dependencies.git.addWorktree).not.toHaveBeenCalled();
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
				createBranch: true,
			});
			expect(dependencies.sessions.create).toHaveBeenCalledWith(worktreePath);
			expect(dependencies.sessions.forkFrom).not.toHaveBeenCalled();
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/new.jsonl");
		});

		it("attaches a worktree to an existing branch instead of creating a new one when the branch already exists locally", async () => {
			const { dependencies } = createDependencies();
			vi.mocked(dependencies.git.branchExists).mockResolvedValueOnce(true);
			vi.mocked(dependencies.runtime.chooseContextTransfer).mockResolvedValueOnce("fresh-session");
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("");

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: "test1" });

			const worktreePath = resolveWorktreePath("/home/test", "my-pi", "test1");
			expect(dependencies.git.addWorktree).toHaveBeenCalledWith(
				expect.objectContaining({
					path: worktreePath,
					branchName: "test1",
					createBranch: false,
				}),
			);
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/new.jsonl");
		});

		it("surfaces git errors via notify and returns without throwing when worktree creation fails", async () => {
			const { dependencies } = createDependencies();
			vi.mocked(dependencies.runtime.chooseContextTransfer).mockResolvedValueOnce("fresh-session");
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("");
			vi.mocked(dependencies.git.addWorktree).mockRejectedValueOnce(
				new Error("fatal: a branch named 'feature/worktree' already exists"),
			);

			const controller = createWorktreeController(dependencies);
			await expect(
				controller.create({ branchName: "feature/worktree" }),
			).resolves.toBeUndefined();

			expect(dependencies.runtime.notify).toHaveBeenCalledWith(
				expect.stringContaining("feature/worktree"),
				"error",
			);
			expect(dependencies.runtime.switchSession).not.toHaveBeenCalled();
		});

		it("returns without side effects when the user cancels the context-transfer prompt for a new worktree", async () => {
			const { dependencies } = createDependencies();
			vi.mocked(dependencies.runtime.chooseContextTransfer).mockResolvedValueOnce(undefined);

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: "feature/worktree" });

			expect(dependencies.git.getStatusPorcelain).not.toHaveBeenCalled();
			expect(dependencies.git.addWorktree).not.toHaveBeenCalled();
			expect(dependencies.sessions.create).not.toHaveBeenCalled();
			expect(dependencies.sessions.forkFrom).not.toHaveBeenCalled();
			expect(dependencies.runtime.switchSession).not.toHaveBeenCalled();
		});

		it("returns without creating a worktree when the user cancels the pending-changes prompt", async () => {
			const { dependencies } = createDependencies();
			vi.mocked(dependencies.runtime.chooseContextTransfer).mockResolvedValueOnce("fresh-session");
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce(" M extensions/worktree/index.ts\n");
			vi.mocked(dependencies.runtime.choosePendingChanges).mockResolvedValueOnce(undefined);

			const controller = createWorktreeController(dependencies);
			await controller.create({ branchName: "feature/worktree" });

			expect(dependencies.git.stashPush).not.toHaveBeenCalled();
			expect(dependencies.git.addWorktree).not.toHaveBeenCalled();
			expect(dependencies.sessions.create).not.toHaveBeenCalled();
			expect(dependencies.sessions.forkFrom).not.toHaveBeenCalled();
			expect(dependencies.runtime.switchSession).not.toHaveBeenCalled();
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
				createBranch: true,
			});
			expect(dependencies.git.stashPop).toHaveBeenCalledWith(worktreePath);
			expect(dependencies.sessions.forkFrom).toHaveBeenCalledWith("/sessions/current.jsonl", worktreePath);
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/forked.jsonl");
		});
	});

	describe("cleanup", () => {
		it("asks the agent to merge into the resolved default branch and stops without destruction when the worktree stays dirty after merge", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			dependencies.env.cwd = currentWorktree.path;
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce(currentWorktree.branch);
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValueOnce([mainRepo, currentWorktree]);
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("UU extensions/worktree/index.ts\n");

			const controller = createWorktreeController(dependencies);
			await controller.cleanup({});

			expect(dependencies.git.detectDefaultBranch).toHaveBeenCalledWith(mainRepo.path);
			expect(dependencies.agent.sendMergeInstruction).toHaveBeenCalledWith(
				buildCleanupMergePrompt(currentWorktree.branch, "main", mainRepo.path),
			);
			expect(dependencies.runtime.notify).toHaveBeenCalled();
			expect(dependencies.git.isAncestor).not.toHaveBeenCalled();
			expect(dependencies.git.removeWorktree).not.toHaveBeenCalled();
			expect(dependencies.git.deleteBranch).not.toHaveBeenCalled();
		});

		it("aborts cleanup without removing anything when the branch is not actually merged into the target", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			dependencies.env.cwd = currentWorktree.path;
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce(currentWorktree.branch);
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValueOnce([mainRepo, currentWorktree]);
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("");
			vi.mocked(dependencies.git.isAncestor).mockResolvedValueOnce(false);

			const controller = createWorktreeController(dependencies);
			await controller.cleanup({ mergeTarget: "release/1.2" });

			expect(dependencies.git.isAncestor).toHaveBeenCalledWith({
				cwd: mainRepo.path,
				ancestor: currentWorktree.branch,
				descendant: "release/1.2",
			});
			expect(dependencies.runtime.notify).toHaveBeenCalled();
			expect(dependencies.git.removeWorktree).not.toHaveBeenCalled();
			expect(dependencies.git.deleteBranch).not.toHaveBeenCalled();
		});

		it("verifies the merge, removes the worktree, force-deletes the branch, forks the current session into the main worktree path, and discards the source session file when cleanup finishes cleanly", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			dependencies.env.cwd = currentWorktree.path;
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce(currentWorktree.branch);
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValue([mainRepo, currentWorktree]);
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("");
			vi.mocked(dependencies.sessions.forkFrom).mockResolvedValueOnce("/sessions/back-in-main.jsonl");

			const controller = createWorktreeController(dependencies);
			await controller.cleanup({ mergeTarget: "release/1.2" });

			expect(dependencies.git.isAncestor).toHaveBeenCalledWith({
				cwd: mainRepo.path,
				ancestor: currentWorktree.branch,
				descendant: "release/1.2",
			});
			expect(dependencies.git.removeWorktree).toHaveBeenCalledWith({
				cwd: mainRepo.path,
				worktreePath: currentWorktree.path,
			});
			expect(dependencies.git.deleteBranch).toHaveBeenCalledWith({
				cwd: mainRepo.path,
				branchName: currentWorktree.branch,
				force: true,
			});
			expect(dependencies.sessions.forkFrom).toHaveBeenCalledWith(
				"/sessions/current.jsonl",
				mainRepo.path,
			);
			expect(dependencies.sessions.create).not.toHaveBeenCalled();
			expect(dependencies.runtime.switchSession).toHaveBeenCalledWith("/sessions/back-in-main.jsonl");
			expect(dependencies.sessions.discard).toHaveBeenCalledWith("/sessions/current.jsonl");
		});

		it("falls back to the configured fallback when the repo has no detectable default branch and the user did not provide one", async () => {
			const { dependencies, mainRepo, currentWorktree } = createDependencies();
			dependencies.env.cwd = currentWorktree.path;
			vi.mocked(dependencies.git.getCurrentBranch).mockResolvedValueOnce(currentWorktree.branch);
			vi.mocked(dependencies.git.listWorktrees).mockResolvedValue([mainRepo, currentWorktree]);
			vi.mocked(dependencies.git.getStatusPorcelain).mockResolvedValueOnce("");
			vi.mocked(dependencies.git.detectDefaultBranch).mockResolvedValueOnce(undefined);

			const controller = createWorktreeController(dependencies);
			await controller.cleanup({});

			expect(dependencies.agent.sendMergeInstruction).toHaveBeenCalledWith(
				buildCleanupMergePrompt(currentWorktree.branch, "main", mainRepo.path),
			);
		});
	});
});
