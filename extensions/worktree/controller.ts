import { buildCleanupMergePrompt, resolveWorktreePath } from "./command-surface.ts";
import type {
	WorktreeController,
	WorktreeDependencies,
	WorktreeEnvironment,
	WorktreeInfo,
	WorktreeSessionGateway,
} from "./contracts.ts";

function findWorktreeByBranch(worktrees: readonly WorktreeInfo[], branchName: string): WorktreeInfo | undefined {
	return worktrees.find((worktree) => worktree.branch === branchName);
}

async function getResumeSessionFile(
	sessions: WorktreeSessionGateway,
	worktreePath: string,
): Promise<string> {
	return (await sessions.continueRecent(worktreePath)) ?? sessions.create(worktreePath);
}

function requireCurrentSessionFile(env: WorktreeEnvironment): string {
	if (!env.currentSessionFile) {
		throw new Error("Cannot bring context into a worktree without a persisted current session");
	}
	return env.currentSessionFile;
}

function requireMainWorktree(worktrees: readonly WorktreeInfo[]): WorktreeInfo {
	const mainWorktree = worktrees.find((worktree) => worktree.isMain);
	if (!mainWorktree) {
		throw new Error("Could not determine the main repository worktree");
	}
	return mainWorktree;
}

function requireWorktreeAtPath(worktrees: readonly WorktreeInfo[], path: string): WorktreeInfo {
	const worktree = worktrees.find((candidate) => candidate.path === path);
	if (!worktree) {
		throw new Error(`Could not find worktree for path: ${path}`);
	}
	return worktree;
}

export function createWorktreeController(dependencies: WorktreeDependencies): WorktreeController {
	const { env, git, sessions, agent, runtime } = dependencies;

	return {
		async create(request) {
			const worktrees = await git.listWorktrees(env.cwd);
			const existing = findWorktreeByBranch(worktrees, request.branchName);
			if (existing) {
				const sessionFile = await getResumeSessionFile(sessions, existing.path);
				await runtime.switchSession(sessionFile);
				return;
			}

			const contextTransfer = await runtime.chooseContextTransfer();
			if (!contextTransfer) {
				return;
			}

			const status = await git.getStatusPorcelain(env.cwd);
			let stashCreated = false;
			if (status.trim().length > 0) {
				const pendingChanges = await runtime.choosePendingChanges();
				if (!pendingChanges) {
					return;
				}
				if (pendingChanges === "bring-changes") {
					stashCreated = await git.stashPush(env.cwd);
				}
			}

			const baseBranch = request.baseBranch ?? await git.getCurrentBranch(env.cwd);
			const worktreePath = resolveWorktreePath(env.homeDirectory, env.repoName, request.branchName);
			await git.addWorktree({
				cwd: env.cwd,
				path: worktreePath,
				branchName: request.branchName,
				baseBranch,
			});

			if (stashCreated) {
				await git.stashPop(worktreePath);
			}

			const sessionFile = contextTransfer === "fresh-session"
				? await sessions.create(worktreePath)
				: await sessions.forkFrom(requireCurrentSessionFile(env), worktreePath);
			await runtime.switchSession(sessionFile);
		},

		async cleanup(request) {
			const currentBranch = await git.getCurrentBranch(env.cwd);
			await agent.sendMergeInstruction(buildCleanupMergePrompt(currentBranch, request.mergeTarget));
			await runtime.waitForIdle();

			const status = await git.getStatusPorcelain(env.cwd);
			if (status.trim().length > 0) {
				runtime.notify(
					"Worktree is still dirty after merge. Resolve remaining changes and re-run /worktree cleanup.",
					"warning",
				);
				return;
			}

			const worktrees = await git.listWorktrees(env.cwd);
			const mainWorktree = requireMainWorktree(worktrees);
			const currentWorktree = requireWorktreeAtPath(worktrees, env.cwd);
			await git.removeWorktree({
				cwd: mainWorktree.path,
				worktreePath: currentWorktree.path,
			});
			await git.deleteBranch({
				cwd: mainWorktree.path,
				branchName: currentWorktree.branch,
				force: false,
			});
			const sessionFile = await sessions.create(mainWorktree.path);
			await runtime.switchSession(sessionFile);
		},
	};
}
